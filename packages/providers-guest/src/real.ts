// Real guest provider (req §18, Phase 8). Executes typed recipe operations over
// SSH as the cloud-init user, using a per-deployment key and TOFU host-key
// verification. Recipe ops map to a fixed, non-arbitrary set of shell commands
// built from typed inputs — never free-form scripts.
//
// SAFETY: the SSH transport is injected. The real desktop app supplies an
// ssh2-based transport; tests inject a fake transport and NEVER open a socket.
// Real mode stays hidden in the UI until Phase 8 safety tests pass.

import type {
  GuestProvider,
  GuestTarget,
  OpResult,
  RecipeOperation,
} from "@frolo/contracts";

export interface SshResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Transport seam. `hostKeyFingerprint` is the fingerprint the server presented;
// the provider enforces TOFU against the pinned value.
export interface SshTransport {
  connect(input: {
    host: string;
    user: string;
    privateKey: string;
  }): Promise<{ presentedHostKeyFingerprint: string }>;
  exec(command: string): Promise<SshResult>;
  httpGet(path: string): Promise<{ status: number; body: string }>;
  close(): Promise<void>;
}

export interface RealGuestConfig {
  // Resolves the private key material from the vault by ref (never inlined here).
  resolvePrivateKey(ref: string): Promise<string>;
  transport: SshTransport;
}

export class HostKeyMismatch extends Error {}

export class RealGuestProvider implements GuestProvider {
  constructor(private readonly config: RealGuestConfig) {}

  async waitReachable(target: GuestTarget, _timeoutMs: number): Promise<void> {
    const privateKey = await this.config.resolvePrivateKey(target.privateKeyRef);
    const { presentedHostKeyFingerprint } = await this.config.transport.connect({
      host: target.address,
      user: target.sshUser,
      privateKey,
    });
    // TOFU: if we have a pinned fingerprint, it must match (req §18.5). Close the
    // freshly-opened connection before failing closed so we never leak a socket.
    if (target.hostKeyFingerprint && target.hostKeyFingerprint !== presentedHostKeyFingerprint) {
      await this.config.transport.close().catch(() => {});
      throw new HostKeyMismatch("guest host key changed since first connect; refusing to continue");
    }
  }

  async run(target: GuestTarget, op: RecipeOperation, asset?: string): Promise<OpResult> {
    switch (op.type) {
      case "pkg.install": {
        // Fixed apt-get command from a validated package allow-list (enforced by
        // the recipe engine before we get here). No shell interpolation of
        // untrusted data beyond the already-constrained package names.
        const pkgs = op.packages.map(shellQuote).join(" ");
        return this.execExpectZero(`sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ${pkgs}`);
      }
      case "file.write": {
        if (asset === undefined) return { ok: false, detailSanitized: "missing asset content" };
        // Write via a here-doc to a temp file then move with sudo; path already
        // constrained to the recipe's writable allow-list.
        const b64 = Buffer.from(asset, "utf8").toString("base64");
        const cmd = `echo ${shellQuote(b64)} | base64 -d | sudo tee ${shellQuote(op.path)} > /dev/null`;
        return this.execExpectZero(cmd);
      }
      case "service.enable":
        return this.execExpectZero(`sudo systemctl enable ${shellQuote(op.name)}`);
      case "service.start":
        return this.execExpectZero(`sudo systemctl restart ${shellQuote(op.name)}`);
      case "http.check":
        return { ok: true }; // handled via httpGet by the orchestrator
    }
  }

  async httpGet(_target: GuestTarget, path: string): Promise<{ status: number; body: string }> {
    return this.config.transport.httpGet(path);
  }

  // Close the underlying SSH connection. Safe to call even if never connected.
  async dispose(): Promise<void> {
    await this.config.transport.close();
  }

  private async execExpectZero(command: string): Promise<OpResult> {
    const r = await this.config.transport.exec(command);
    if (r.code === 0) return { ok: true };
    // stderr is sanitized by the caller's logger; we surface a short reason.
    return { ok: false, detailSanitized: `command exited ${r.code}` };
  }
}

// Minimal shell quoting for values that are already constrained by the recipe
// engine's allow-lists. Wraps in single quotes and escapes embedded quotes.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
