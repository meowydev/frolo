// Controller runtime dependencies. The composition root assembles these,
// choosing fake or real implementations based on mode. Everything above the
// provider layer sees only these interfaces (req §13).

import type {
  Clock,
  GuestProvider,
  Logger,
  ProxmoxProvider,
  RouterProvider,
  Vault,
} from "@frolo/contracts";
import type { FroloStore } from "@frolo/store";
import { Sanitizer } from "@frolo/core";

export interface KeyGenerator {
  // Generate an SSH keypair for a deployment. Returns the private key material
  // (stored in the vault) and a public key + host-key fingerprint the guest
  // will present (for TOFU). The fake models this without real crypto ceremony.
  generate(deploymentId: string): {
    privateKey: string;
    publicKey: string;
    expectedHostKeyFingerprint: string;
  };
}

export interface ControllerDeps {
  mode: "mock" | "real";
  store: FroloStore;
  vault: Vault;
  sanitizer: Sanitizer;
  clock: Clock;
  logger: Logger;
  keygen: KeyGenerator;

  // Provider factories: exposure/router need a per-router provider bound to a
  // fixture/URL, so we pass factories rather than singletons where needed.
  proxmox: ProxmoxProvider;
  guest: GuestProvider;
  // Returns the router provider for a given router profile id.
  routerFor(routerProfileId: string): RouterProvider;

  // Simulated NAT chain hook (mock only) so exposure verification can probe
  // end-to-end reachability. In real mode this is undefined and verification
  // relies on the router's own find-mapping workflow.
  nat?: {
    apply(m: import("@frolo/contracts").HopMapping): void;
    remove(m: import("@frolo/contracts").HopMapping): void;
    probe(plan: import("@frolo/contracts").ExposurePlan): boolean;
  };
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  isoNow(): string {
    return new Date().toISOString();
  }
}

// A logger that runs every message through the sanitizer before emitting.
export class SanitizingLogger implements Logger {
  constructor(
    private readonly sanitizer: Sanitizer,
    private readonly sink: (line: string) => void = (l) => console.log(l),
  ) {}
  info(msg: string, meta?: Record<string, unknown>): void {
    this.emit("info", msg, meta);
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.emit("warn", msg, meta);
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    this.emit("error", msg, meta);
  }
  private emit(level: string, msg: string, meta?: Record<string, unknown>): void {
    const base = meta ? `${msg} ${JSON.stringify(meta)}` : msg;
    this.sink(`[${level}] ${this.sanitizer.sanitize(base)}`);
  }
}
