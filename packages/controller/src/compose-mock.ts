// Composition root for MOCK mode (req §1.3, §13.3). Assembles the controller
// with fake providers, an in-memory-or-file vault, and the SQLite store. Real
// mode uses a separate composition root (Phase 8) and stays hidden until then.

import { Sanitizer, NGINX_RECIPE } from "@frolo/core";
import { FroloStore } from "@frolo/store";
import {
  Aes256GcmVault,
  InMemoryFileStore,
  InMemoryKeychain,
  NodeAtomicFileStore,
  OsKeychain,
  type AtomicFileStore,
} from "@frolo/vault";
import { FakeProxmoxProvider, type FakeProxmoxOptions } from "@frolo/providers-proxmox";
import { FakeGuestProvider, type FakeGuestOptions } from "@frolo/providers-guest";
import {
  FakeRouterProvider,
  RouterFixtureA,
  RouterFixtureB,
  SimulatedNatChain,
  fixtureAWorkflows,
  fixtureBWorkflows,
  type RouterFixture,
} from "@frolo/providers-router";
import type { KeychainAdapter, PublicVerificationKey, RouterProvider } from "@frolo/contracts";
import { Controller, type ControllerConfig } from "./controller.js";
import { SystemClock, SanitizingLogger, type ControllerDeps } from "./deps.js";
import { FakeKeyGenerator } from "./keygen.js";

export interface MockComposeOptions {
  storePath?: string; // ":memory:" by default
  vaultPath?: string;
  useOsKeychain?: boolean; // desktop app sets true; tests leave false
  proxmox?: FakeProxmoxOptions;
  guest?: FakeGuestOptions;
  vmAddress?: string; // VM address the NAT chain expects (for exposure)
  licenseKeys?: PublicVerificationKey[];
  allowDevLicenseKeys?: boolean;
  logSink?: (line: string) => void;
}

export interface MockComposition {
  controller: Controller;
  store: FroloStore;
  proxmox: FakeProxmoxProvider;
  guest: FakeGuestProvider;
  fixtures: Map<string, RouterFixture>;
  nat: SimulatedNatChain;
}

// Wire a mock composition. Router profiles are registered lazily: the caller
// creates router profiles + seeds fixture workflows via seedRouter().
export async function composeMock(opts: MockComposeOptions = {}): Promise<MockComposition> {
  const sanitizer = new Sanitizer();
  const store = new FroloStore(opts.storePath ?? ":memory:");
  const clock = new SystemClock();
  const logger = new SanitizingLogger(sanitizer, opts.logSink);

  const keychain: KeychainAdapter = opts.useOsKeychain
    ? new OsKeychain()
    : new InMemoryKeychain();
  const fileStore: AtomicFileStore = opts.vaultPath
    ? new NodeAtomicFileStore()
    : new InMemoryFileStore();
  const vault = new Aes256GcmVault(opts.vaultPath ?? "/tmp/frolo-mock.vault", keychain, fileStore);
  await vault.unlock();

  const proxmox = new FakeProxmoxProvider(opts.proxmox);
  const guest = new FakeGuestProvider(opts.guest);
  const fixtures = new Map<string, RouterFixture>();
  const routers = new Map<string, RouterProvider>();
  const nat = new SimulatedNatChain(opts.vmAddress ?? "192.168.7.50");

  const deps: ControllerDeps = {
    mode: "mock",
    store,
    vault,
    sanitizer,
    clock,
    logger,
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

  const config: ControllerConfig = {
    licenseKeys: opts.licenseKeys ?? [],
    allowDevLicenseKeys: opts.allowDevLicenseKeys ?? true, // dev/mock allows dev keys
  };

  const controller = new Controller(deps, config);
  controller.registerBuiltinRecipe(NGINX_RECIPE);

  // Expose an internal helper to register routers (used by seedRouter()).
  registerHelper.set(controller, (id, fixture) => {
    fixtures.set(id, fixture);
    routers.set(id, new FakeRouterProvider(fixture));
  });

  return { controller, store, proxmox, guest, fixtures, nat };
}

// Register a router profile + its fixture + pre-recorded workflows (req §14.5a).
export function seedRouter(
  composition: MockComposition,
  input: {
    id: string;
    name: string;
    kind: "fixtureA" | "fixtureB";
    baseUrl: string;
    wanAddress: string;
  },
): void {
  const fixture: RouterFixture =
    input.kind === "fixtureA" ? new RouterFixtureA() : new RouterFixtureB();
  const register = registerHelper.get(composition.controller);
  register?.(input.id, fixture);

  composition.store.saveRouterProfile({
    id: input.id,
    name: input.name,
    baseUrl: input.baseUrl,
    scheme: "http",
    kind: input.kind,
  });
  const workflows =
    input.kind === "fixtureA" ? fixtureAWorkflows(input.id) : fixtureBWorkflows(input.id);
  for (const w of workflows) composition.store.saveWorkflow(w);
}

// Weak side-channel so seedRouter can reach the router registry without leaking
// it onto the public Controller surface.
const registerHelper = new WeakMap<
  Controller,
  (id: string, fixture: RouterFixture) => void
>();
