// Server application context: assembles the controller (mock or real), the auth
// store, the vault, and the raw SQLite handle for the auth tables. Everything
// runs together on the Frolo VM (req: controller/DB/vault/providers/web server
// co-located).

import Database from "better-sqlite3";
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
import { FakeProxmoxProvider } from "@frolo/providers-proxmox";
import { FakeGuestProvider } from "@frolo/providers-guest";
import {
  FakeRouterProvider,
  RouterFixtureA,
  RouterFixtureB,
  SimulatedNatChain,
  fixtureAWorkflows,
  fixtureBWorkflows,
  type RouterFixture,
} from "@frolo/providers-router";
import type { PublicVerificationKey, RouterProvider } from "@frolo/contracts";
import {
  Controller,
  FakeKeyGenerator,
  SanitizingLogger,
  SystemClock,
  type ControllerDeps,
} from "@frolo/controller";
import { AuthStore } from "./auth/auth-store.js";

export interface ServerConfig {
  dataDir: string; // e.g. /opt/frolo/data
  inMemory?: boolean; // tests
  licenseKeys?: PublicVerificationKey[];
  allowDevLicenseKeys?: boolean;
}

export interface AppContext {
  controller: Controller;
  authStore: AuthStore;
  store: FroloStore;
  vault: Aes256GcmVault;
  db: Database.Database;
  sanitizer: Sanitizer;
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
  // Share the same underlying database handle for the auth tables.
  const db = config.inMemory ? new Database(":memory:") : new Database(dbPath);
  const authStore = new AuthStore(db);

  const keychain = config.inMemory ? new InMemoryKeychain() : new FileKeychain(keyFile);
  const fileStore = config.inMemory ? new InMemoryFileStore() : new NodeAtomicFileStore();
  const vault = new Aes256GcmVault(vaultPath, keychain, fileStore);
  await vault.unlock();
  const masterKey = (await keychain.getKey("frolo-master-key"))!;

  const proxmox = new FakeProxmoxProvider();
  const guest = new FakeGuestProvider();
  const routers = new Map<string, RouterProvider>();
  const fixtures = new Map<string, RouterFixture>();
  const nat = new SimulatedNatChain("192.168.7.50");

  const deps: ControllerDeps = {
    mode: "mock",
    store,
    vault,
    sanitizer,
    clock: new SystemClock(),
    logger: new SanitizingLogger(sanitizer),
    keygen: new FakeKeyGenerator(),
    proxmox,
    guest,
    routerFor: (id) => {
      const p = routers.get(id);
      if (!p) throw new Error(`no router provider for ${id}`);
      return p;
    },
    nat: {
      apply: (m) => nat.apply(m),
      remove: (m) => nat.remove(m),
      probe: (plan) => nat.probe(plan),
    },
  };

  const controller = new Controller(deps, {
    licenseKeys: config.licenseKeys ?? [],
    allowDevLicenseKeys: config.allowDevLicenseKeys ?? true,
  });
  controller.registerBuiltinRecipe(NGINX_RECIPE);

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
    seedMockRouter,
    nat,
    masterKey,
    close: () => {
      store.close();
      db.close();
    },
  };
}
