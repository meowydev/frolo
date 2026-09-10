// Fake Ubuntu guest provider (req §14.2, §5A, §18). Models a filesystem +
// service table + the trust flow (injected key, TOFU host key, guest agent).
// Executes typed recipe ops; httpGet serves the written page so the marker
// check passes. Failure knobs drive the Failed-path tests.

import type {
  GuestProvider,
  GuestTarget,
  OpResult,
  RecipeOperation,
} from "@frolo/contracts";

export interface FakeGuestOptions {
  // Register the public key that cloud-init "injected"; SSH is refused otherwise.
  authorizedKeyFingerprint?: string;
  // The guest's host key fingerprint (for TOFU pinning). Change to simulate MITM.
  hostKeyFingerprint?: string;
  // Failure knobs:
  failInstallPackages?: string[]; // pkg.install fails for these
  markerMissing?: boolean; // page written without the marker
  unreachable?: boolean; // waitReachable fails
}

interface GuestState {
  files: Map<string, string>;
  servicesEnabled: Set<string>;
  servicesRunning: Set<string>;
}

export class FakeGuestProvider implements GuestProvider {
  private readonly state: GuestState = {
    files: new Map(),
    servicesEnabled: new Set(),
    servicesRunning: new Set(),
  };

  constructor(private readonly opts: FakeGuestOptions = {}) {}

  async waitReachable(target: GuestTarget, _timeoutMs: number): Promise<void> {
    if (this.opts.unreachable) {
      throw new Error("guest did not become reachable");
    }
    // TOFU host-key verification (req §18.5): if the target has a pinned
    // fingerprint that disagrees with the guest's, fail closed.
    const guestFp = this.opts.hostKeyFingerprint ?? "SHA256:fake-host-key";
    if (target.hostKeyFingerprint && target.hostKeyFingerprint !== guestFp) {
      throw new Error("host key mismatch (possible MITM); refusing to connect");
    }
    // DHCP address readback requires the guest agent (req §18.7). The provider
    // caller enforces that; here we just make sure a target address exists.
    if (!target.address) throw new Error("no guest address");
  }

  // Assets carry file contents (from the recipe). The orchestrator passes the
  // resolved asset string for file.write ops.
  async run(target: GuestTarget, op: RecipeOperation, asset?: string): Promise<OpResult> {
    switch (op.type) {
      case "pkg.install": {
        for (const pkg of op.packages) {
          if (this.opts.failInstallPackages?.includes(pkg)) {
            return { ok: false, detailSanitized: `apt-get install ${pkg} failed` };
          }
        }
        return { ok: true, detailSanitized: `installed ${op.packages.join(", ")}` };
      }
      case "file.write": {
        let content = asset ?? "";
        if (this.opts.markerMissing) {
          // Simulate a botched write: strip any marker-looking token.
          content = content.replace(/FROLO-OK-[\w-]+/g, "MISSING");
        }
        this.state.files.set(op.path, content);
        return { ok: true, detailSanitized: `wrote ${op.path}` };
      }
      case "service.enable":
        this.state.servicesEnabled.add(op.name);
        return { ok: true, detailSanitized: `enabled ${op.name}` };
      case "service.start":
        this.state.servicesRunning.add(op.name);
        return { ok: true, detailSanitized: `started ${op.name}` };
      case "http.check":
        // http.check is executed via httpGet by the orchestrator; treat as noop here.
        return { ok: true };
    }
  }

  async httpGet(_target: GuestTarget, path: string): Promise<{ status: number; body: string }> {
    // Serve nginx only if it is running.
    if (!this.state.servicesRunning.has("nginx")) {
      return { status: 502, body: "" };
    }
    const file = path === "/" ? "/var/www/html/index.html" : `/var/www/html${path}`;
    const body = this.state.files.get(file);
    if (body === undefined) return { status: 404, body: "" };
    return { status: 200, body };
  }

  // --- test helpers ---
  fileAt(path: string): string | undefined {
    return this.state.files.get(path);
  }
  isRunning(service: string): boolean {
    return this.state.servicesRunning.has(service);
  }
  isEnabled(service: string): boolean {
    return this.state.servicesEnabled.has(service);
  }
}
