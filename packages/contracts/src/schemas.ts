// Zod schemas for runtime validation of untrusted input (IPC payloads, recipes,
// licenses). Keep in sync with domain.ts / licensing.ts.

import { z } from "zod";
import { FROLO_TIERS } from "./licensing.js";

export const networkModeSchema = z.enum(["dhcp", "manual", "vmid"]);

export const networkProfileSchema = z
  .object({
    id: z.string(),
    name: z.string().min(1),
    mode: networkModeSchema,
    subnetCidr: z.string().optional(),
    gateway: z.string().optional(),
    address: z.string().optional(),
    vmidRule: z.object({ offset: z.number().int() }).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.mode === "manual") {
      if (!val.address || !val.gateway || !val.subnetCidr) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "manual mode requires address, gateway, and subnetCidr",
        });
      }
    }
    if (val.mode === "vmid") {
      if (!val.subnetCidr || !val.vmidRule) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "vmid mode requires subnetCidr and vmidRule",
        });
      }
    }
  });

export const recipeOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pkg.install"), packages: z.array(z.string().min(1)).min(1) }),
  z.object({
    type: z.literal("file.write"),
    path: z.string().min(1),
    contentRef: z.string().min(1),
    mode: z.string().optional(),
  }),
  z.object({ type: z.literal("service.enable"), name: z.string().min(1) }),
  z.object({ type: z.literal("service.start"), name: z.string().min(1) }),
  z.object({
    type: z.literal("http.check"),
    path: z.string().min(1),
    expectStatus: z.number().int(),
    expectContains: z.string().min(1),
  }),
]);

export const recipeConstraintsSchema = z.object({
  writablePaths: z.array(z.string().min(1)),
  packages: z.array(z.string()),
  services: z.array(z.string()),
});

export const recipeSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  version: z.string().min(1),
  source: z.literal("builtin"),
  operations: z.array(recipeOperationSchema).min(1),
  constraints: recipeConstraintsSchema,
  assets: z.record(z.string()),
});

export const protocolSchema = z.enum(["tcp", "udp"]);

export const deploymentPlanSchema = z.object({
  name: z.string().min(1),
  connectionId: z.string(),
  templateVmid: z.number().int().positive(),
  cores: z.number().int().positive(),
  ramMb: z.number().int().positive(),
  diskGb: z.number().int().positive(),
  hostname: z.string().min(1),
  sshUser: z.string().min(1),
  networkProfileId: z.string(),
  recipeId: z.string(),
  chainId: z.string().optional(),
  exposure: z
    .object({
      protocol: protocolSchema,
      publicPort: z.number().int().min(1).max(65535),
      internalPort: z.number().int().min(1).max(65535),
    })
    .optional(),
});

// --- Licensing -------------------------------------------------------------
export const licensePayloadSchema = z.object({
  v: z.literal(1),
  subject: z.string().min(1),
  tier: z.enum(FROLO_TIERS),
  issuedAt: z.string().min(1),
  expiresAt: z.string().min(1),
  graceDays: z.number().int().min(0).max(60),
  licenseId: z.string().min(1),
  keyId: z.string().min(1),
});

export const signedLicenseSchema = z.object({
  payload: licensePayloadSchema,
  signature: z.string().min(1),
  alg: z.literal("ed25519"),
});
