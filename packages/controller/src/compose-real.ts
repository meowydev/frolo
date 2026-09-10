// Composition root for REAL mode (Phase 8). Assembles the controller with the
// real providers. This is only reachable when the real-mode readiness gate is
// open (FROLO_ENABLE_REAL_MODE=1 + safety tests recorded as passing). It requires
// the caller (Electron main) to supply the actual transports (HTTPS, SSH,
// Playwright page driver) and the persistent store/vault paths.
//
// SAFETY: composeReal() refuses to build when the readiness gate is closed, so
// no real connection can be made by default. Secrets (Proxmox token, guest key,
// router credentials) are resolved from the vault at call time and never logged.

import { Sanitizer, NGINX_RECIPE } from "@frolo/core";
import { FroloStore } from "@frolo/store";
import {
  Aes256GcmVault,
  NodeAtomicFileStore,
  OsKeychain,
  SecretRefs,
} from "@frolo/vault";
import {
  RealProxmoxProvider,
  type HttpsTransport,
  type RealProxmoxConfig,
} from "@frolo/providers-proxmox";
import { RealGuestProvider, type SshTransport } from "@frolo/providers-guest";
import { RealRouterProvider, type PageDriver } from "@frolo/providers-router";
import type { PublicVerificationKey, RouterTrust } from "@frolo/contracts";
import { Controller, type ControllerConfig } from "./controller.js";
import { SystemClock, SanitizingLogger, type ControllerDeps } from "./deps.js";
import { RealKeyGenerator } from "./keygen.js";
import { realModeReadiness } from "./real-readiness.js";

export interface RealComposeOptions {
  storePath: string;
  vaultPath: string;
  proxmox: Omit<RealProxmoxConfig, "tokenSecret"> & { connectionId: string };
  httpsTransport: HttpsTransport;
  sshTransport: SshTransport;
  openPageDriver: (routerUrl: string, trust: RouterTrust) => Promise<PageDriver>;
  licenseKeys: PublicVerificationKey[];
  allowDevLicenseKeys?: boolean;
  logSink?: (line: string) => void;
  // For testability: override the readiness gate (tests pass a stub to prove the
  // wiring compiles WITHOUT ever opening a real connection).
  readiness?: () => { available: boolean; reason: string };
}

export interface RealComposition {
  controller: Controller;
  store: FroloStore;
}

export async function composeReal(opts: RealComposeOptions): Promise<RealComposition> {
  const gate = (opts.readiness ?? realModeReadiness)();
  if (!gate.available) {
    throw new Error(`real mode is not available: ${gate.reason}`);
  }

  const sanitizer = new Sanitizer();
  const store = new FroloStore(opts.storePath);
  const clock = new SystemClock();
  const logger = new SanitizingLogger(sanitizer, opts.logSink);

  const vault = new Aes256GcmVault(opts.vaultPath, new OsKeychain(), new NodeAtomicFileStore());
  await vault.unlock();

  // Resolve the Proxmox token secret from the vault (never inline).
  const tokenSecret = await vault.get(SecretRefs.proxmoxToken(opts.proxmox.connectionId));
  sanitizer.register(tokenSecret);
  const proxmox = new RealProxmoxProvider(
    {
      host: opts.proxmox.host,
      node: opts.proxmox.node,
      tokenId: opts.proxmox.tokenId,
      tokenSecret,
      pinnedCertSha256: opts.proxmox.pinnedCertSha256,
    },
    opts.httpsTransport,
  );

  const guest = new RealGuestProvider({
    resolvePrivateKey: (ref) => vault.get(ref),
    transport: opts.sshTransport,
  });

  const routers = new RealRouterProvider({ openDriver: opts.openPageDriver });

  const deps: ControllerDeps = {
    mode: "real",
    store,
    vault,
    sanitizer,
    clock,
    logger,
    keygen: new RealKeyGenerator(),
    proxmox,
    guest,
    routerFor: () => routers,
    // No simulated NAT in real mode; verification relies on the router's own
    // find-mapping workflow (req §10.5).
    nat: undefined,
  };

  const config: ControllerConfig = {
    licenseKeys: opts.licenseKeys,
    allowDevLicenseKeys: opts.allowDevLicenseKeys ?? false,
  };

  const controller = new Controller(deps, config);
  controller.registerBuiltinRecipe(NGINX_RECIPE);
  return { controller, store };
}
