#!/usr/bin/env node
// DEVELOPMENT-ONLY admin CLI for issuing Frolo licenses.
//
// This documents the input/output contract the FUTURE private issuer service
// will implement. It does NOT contain a production signing secret. In this repo
// it can only mint clearly-marked "dev-fake" licenses using an ephemeral key,
// or a key supplied at runtime via an env var path (never committed).
//
// Contract (stdin JSON or flags) -> stdout JSON:
//   input:  { "subject": string, "tier": "home"|"advanced_user"|"powerfullness",
//             "validityDays"?: number, "graceDays"?: number, "licenseId"?: string }
//   output: { "license": SignedLicense, "publicKey": PublicVerificationKey }
//
// The production service MUST:
//   - hold the private key in an HSM / secret manager, never on disk in repo,
//   - map Boosty subscriber records to `subject` codes,
//   - emit the same SignedLicense JSON shape defined in @frolo/contracts.

import { createDevIssuer } from "../dev-issuer.js";
import type { FroloTier } from "@frolo/contracts";
import { FROLO_TIERS } from "@frolo/contracts";

interface CliInput {
  subject: string;
  tier: FroloTier;
  validityDays?: number;
  graceDays?: number;
  licenseId?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function parseArgs(argv: string[]): Partial<CliInput> {
  const out: Partial<CliInput> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--subject" && next) (out.subject = next), i++;
    else if (a === "--tier" && next) (out.tier = next as FroloTier), i++;
    else if (a === "--validity-days" && next) (out.validityDays = Number(next)), i++;
    else if (a === "--grace-days" && next) (out.graceDays = Number(next)), i++;
    else if (a === "--license-id" && next) (out.licenseId = next), i++;
  }
  return out;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  let input: Partial<CliInput> = flags;
  if (!process.stdin.isTTY) {
    const raw = (await readStdin()).trim();
    if (raw) input = { ...JSON.parse(raw), ...flags };
  }

  if (!input.subject || !input.tier || !FROLO_TIERS.includes(input.tier)) {
    process.stderr.write(
      "error: require --subject and --tier (home|advanced_user|powerfullness)\n" +
        "This DEV CLI only mints non-production 'dev-fake' licenses.\n",
    );
    process.exit(2);
    return;
  }

  const issuer = createDevIssuer();
  const license = issuer.issue({
    subject: input.subject,
    tier: input.tier,
    validityDays: input.validityDays ?? 35,
    graceDays: input.graceDays ?? 5,
    licenseId: input.licenseId,
  });

  process.stdout.write(
    JSON.stringify(
      {
        _warning:
          "DEVELOPMENT license signed with an ephemeral dev-fake key. Not valid in production builds.",
        license,
        publicKey: issuer.publicKey,
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
