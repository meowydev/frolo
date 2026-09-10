// Server application context: assembles the controller (mock or real), the auth
// store, the vault, and the raw SQLite handle for the auth tables. Everything
// runs together on the Frolo VM (req: controller/DB/vault/providers/web server
// co-located).

import type Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { Sanitizer, NGINX_RECIPE } from "@frolo/core";
import { FroloStore } from "@frolo/store";
import {
  Aes256GcmVault,
  FileKeychain,
  NodeAtomicFileStore,
  InMemoryKeychain,
  InMemoryFileStore,
} from "@frolo/vault";
import { SecretRefs } from "@frolo/vault";
import { FakeProxmoxProvider, RealProxmoxProvider, NodeHttpsTransport } from "@frolo/providers-proxmox";
import { FakeGuestProvider, RealGuestProvider, Ssh2Transport } from "@frolo/providers-guest";
import {
  FakeRouterProvider,
  RealRouterProvider,
  makePlaywrightRouterConfig,
  RouterFixtureA,
  RouterFixtureB,
  SimulatedNatChain,
  fixtureAWorkflows,
  fixtureBWorkflows,
  type RouterFixture,
} from "@frolo/providers-router";
import type {
  GuestProvider,
  ProxmoxProvider,
  PublicVerificationKey,
  RouterProvider,
} from "@frolo/contracts";
import {
  Controller,
  FakeKeyGenerator,
  RealKeyGenerator,
  realModeReadiness,
  SanitizingLogger,
  SystemClock,
  type ControllerDeps,
} from "@frolo/controller";
import { AuthStore } from "./auth/auth-store.js";
import { SourceUpdater } from "./updater.js";
import { makeNodeUpdaterIo, updaterLayout } from "./updater-node.js";

export interface ServerConfig {
  dataDir: string; // e.g. /opt/frolo/data
  inMemory?: boolean; // tests
  licenseKeys?: PublicVerificationKey[];
  allowDevLicenseKeys?: boolean;
  version?: string; // running build version (FROLO_VERSION)
  // Source-deployment release root (<root>/releases + <root>/current). When set,
  // the source-based updater is enabled. Unset for Docker/dev (updater is null).
  releaseRoot?: string;
  allowPrerelease?: boolean;
}

export interface AppContext {
  controller: Controller;
  authStore: AuthStore;
  store: FroloStore;
  vault: Aes256GcmVault;
  db: Database.Database;
  sanitizer: Sanitizer;
  // The mode this context was actually built in (mock unless real is enabled +
  // ready + a connection is configured). Changing to real requires restarting
  // the server so providers are rebound — the API exposes that as a two-step
  // "enable real mode" then restart.
  effectiveMode: "mock" | "real";
  realModeReady: boolean;
  // Source-based updater. Null when the deployment has no release root (Docker
  // images update by pulling a new tag; dev runs from the working tree).
  updater: SourceUpdater | null;
  // Mock-mode router registry so OOBE/mock deployments can seed fixtures.
  seedMockRouter: (input: {
    id: string;
    name: string;
    kind: "fixtureA" | "fixtureB";
    baseUrl: string;
    wanAddress: string;
  }) => void;
  nat: SimulatedNatChain;
  masterKey: Buffer;
  close: () => void;
}

// Build the full app context. For the beta, the controller runs in MOCK mode by
// default; real mode remains gated by the controller's readiness check.
export async function buildContext(config: ServerConfig): Promise<AppContext> {
  const dbPath = config.inMemory ? ":memory:" : join(config.dataDir, "frolo.sqlite");
  const vaultPath = config.inMemory ? "/tmp/frolo-mem.vault" : join(config.dataDir, "frolo.vault");
  const keyFile = join(config.dataDir, "keys", "master");

  if (!config.inMemory) mkdirSync(config.dataDir, { recursive: true });

  const sanitizer = new Sanitizer();
  const store = new FroloStore(dbPath);
  // Share the SINGLE better-sqlite3 handle for the auth tables. Opening a second
  // connection to the same file crashes under GC (native finalizer assertion),
  // so the AuthStore reuses the store's connection.
  const db = store.rawDb();
  const authStore = new AuthStore(db);

  const keychain = config.inMemory ? new InMemoryKeychain() : new FileKeychain(keyFile);
  const fileStore = config.inMemory ? new InMemoryFileStore() : new NodeAtomicFileStore();
  const vault = new Aes256GcmVault(vaultPath, keychain, fileStore);
  await vault.unlock();
  const masterKey = (await keychain.getKey("frolo-master-key"))!;

  const routers = new Map<string, RouterProvider>();
  const fixtures = new Map<string, RouterFixture>();
  const nat = new SimulatedNatChain("192.168.7.50");

  // Decide the runtime mode. Real mode is used ONLY when: the readiness gate is
  // open, the persisted runtime config says "real", and an active Proxmox
  // connection exists with its token secret in the vault. Otherwise we stay in
  // mock mode — this keeps the free/mock experience fully working and ensures
  // real providers are never even constructed unless explicitly enabled.
  const runtime = store.getRuntimeConfig();
  const readiness = realModeReadiness();
  let effectiveMode: "mock" | "real" = "mock";
  let proxmox: ProxmoxProvider = new FakeProxmoxProvider();
  let guest: GuestProvider = new FakeGuestProvider();
  let realNode = "pve";

  if (runtime.mode === "real" && readiness.available && runtime.activeConnectionId) {
    const conn = store.getConnection(runtime.activeConnectionId);
    const tokenRef = SecretRefs.proxmoxToken(runtime.activeConnectionId);
    if (conn && (await vault.has(tokenRef))) {
      const tokenSecret = await vault.get(tokenRef);
      sanitizer.register(tokenSecret);
      effectiveMode = "real";
      realNode = conn.node;
      proxmox = new RealProxmoxProvider(
        {
          host: conn.host,
          node: conn.node,
          tokenId: conn.tokenId,
          tokenSecret,
          pinnedCertSha256: conn.certFingerprint,
        },
        new NodeHttpsTransport(),
      );
      guest = new RealGuestProvider({
        resolvePrivateKey: (ref) => vault.get(ref),
        transport: new Ssh2Transport(),
      });
    }
  }

  // Router provider factory. In mock mode, fixtures are seeded via seedMockRouter.
  // In real mode, a Playwright-backed provider drives the real router UI (headless
  // for replay). Teach Mode recording opens a visible window (handled elsewhere).
  const realRouterConfig = makePlaywrightRouterConfig({ headless: true });
  const realRouter = new RealRouterProvider(realRouterConfig);

  const deps: ControllerDeps = {
    mode: effectiveMode,
    store,
    vault,
    sanitizer,
    clock: new SystemClock(),
    logger: new SanitizingLogger(sanitizer),
    keygen: effectiveMode === "real" ? new RealKeyGenerator() : new FakeKeyGenerator(),
    proxmox,
    guest,
    routerFor: (id) => {
      if (effectiveMode === "real") return realRouter;
      const p = routers.get(id);
      if (!p) throw new Error(`no router provider for ${id}`);
      return p;
    },
    // Simulated NAT only in mock mode; real mode verifies via the router's own
    // find-mapping workflow.
    nat:
      effectiveMode === "real"
        ? undefined
        : {
            apply: (m) => nat.apply(m),
            remove: (m) => nat.remove(m),
            probe: (plan) => nat.probe(plan),
          },
  };

  // Dev license keys are refused by DEFAULT (production-safe). They are accepted
  // ONLY when the caller explicitly opts in (tests) OR an explicit dev flag is
  // set in the environment. A normal production container never sets these, so
  // development "dev-fake" licenses are rejected out of the box.
  const allowDevLicenseKeys =
    config.allowDevLicenseKeys ?? devLicenseKeysAllowedFromEnv();
  const controller = new Controller(deps, {
    licenseKeys: config.licenseKeys ?? [],
    allowDevLicenseKeys,
  });
  controller.registerBuiltinRecipe(NGINX_RECIPE);
  void realNode;

  // Source-based updater — only when a release root is configured (source
  // deployment). Docker/dev leave this null. Never enabled in tests unless the
  // caller explicitly passes releaseRoot.
  let updater: SourceUpdater | null = null;
  if (config.releaseRoot) {
    const layout = updaterLayout(config.releaseRoot);
    updater = new SourceUpdater(
      {
        repo: "meowydev/frolo",
        currentVersion: config.version ?? "0.0.0",
        releasesRoot: layout.releasesRoot,
        currentLink: layout.currentLink,
        allowPrerelease: config.allowPrerelease ?? false,
        githubToken: process.env.FROLO_GITHUB_TOKEN,
      },
      makeNodeUpdaterIo({
        currentLink: layout.currentLink,
        restartCommand: process.env.FROLO_RESTART_COMMAND,
        restartArgs: process.env.FROLO_RESTART_ARGS?.split(" ").filter(Boolean),
      }),
    );
  }

  const seedMockRouter: AppContext["seedMockRouter"] = (input) => {
    const fixture: RouterFixture = input.kind === "fixtureA" ? new RouterFixtureA() : new RouterFixtureB();
    fixtures.set(input.id, fixture);
    routers.set(input.id, new FakeRouterProvider(fixture));
    store.saveRouterProfile({
      id: input.id,
      name: input.name,
      baseUrl: input.baseUrl,
      scheme: "http",
      kind: input.kind,
    });
    const wfs = input.kind === "fixtureA" ? fixtureAWorkflows(input.id) : fixtureBWorkflows(input.id);
    for (const w of wfs) store.saveWorkflow(w);
  };

  return {
    controller,
    authStore,
    store,
    vault,
    db,
    sanitizer,
    effectiveMode,
    realModeReady: readiness.available,
    updater,
    seedMockRouter,
    nat,
    masterKey,
    close: () => {
      // db and store share ONE handle — close it once.
      store.close();
    },
  };
}

// Whether development-signed ("dev-fake") licenses may be accepted. FALSE unless
// an explicit dev flag is present. Production images set NODE_ENV=production and
// none of these flags, so dev keys are refused. `FROLO_DEV=1` (or the explicit
// `FROLO_ALLOW_DEV_LICENSE_KEYS=1`) turns them on for local development only.
export function devLicenseKeysAllowedFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.FROLO_ALLOW_DEV_LICENSE_KEYS === "1") return true;
  if (env.FROLO_DEV === "1") return true;
  return false;
}
