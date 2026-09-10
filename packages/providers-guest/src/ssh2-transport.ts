// Real SSH transport for the guest provider (Task 2), backed by the `ssh2`
// library. `ssh2` is an OPTIONAL dependency: it is only required when a real
// deployment actually runs. Tests inject a fake transport and never open a
// socket; this module is dynamically imported so the package builds and unit
// tests run without the native/optional dep installed.
//
// Security:
//  - Authenticates with the per-deployment private key (passed in by the
//    caller, resolved from the vault; never logged).
//  - Computes the SHA-256 host-key fingerprint the server presents so the
//    RealGuestProvider can enforce Trust-On-First-Use (TOFU) pinning. We accept
//    the key at the transport layer (hostVerifier returns true) and let the
//    provider compare the fingerprint against the pinned value — a mismatch
//    fails the deployment closed.
//  - httpGet runs a constrained `curl` on the guest to verify the app locally
//    (the guest serves nginx on 127.0.0.1). No arbitrary command is exposed.

import { createHash } from "node:crypto";
import type { SshResult, SshTransport } from "./real.js";

// Minimal structural types for the parts of `ssh2` we use, so this file
// type-checks without the dependency's types being installed.
interface Ssh2ClientChannel {
  on(event: "close", cb: (code: number | null) => void): this;
  on(event: "data", cb: (chunk: Buffer) => void): this;
  stderr: { on(event: "data", cb: (chunk: Buffer) => void): void };
}
interface Ssh2Client {
  on(event: "ready", cb: () => void): this;
  on(event: "error", cb: (err: Error) => void): this;
  connect(cfg: Record<string, unknown>): void;
  exec(cmd: string, cb: (err: Error | undefined, chan: Ssh2ClientChannel) => void): void;
  end(): void;
}

export interface Ssh2TransportOptions {
  port?: number;
  connectTimeoutMs?: number;
}

export class Ssh2Transport implements SshTransport {
  private client: Ssh2Client | null = null;
  private presentedFingerprint = "";

  constructor(private readonly opts: Ssh2TransportOptions = {}) {}

  async connect(input: { host: string; user: string; privateKey: string }): Promise<{ presentedHostKeyFingerprint: string }> {
    // Computed specifier so tsc does not statically resolve the optional dep.
    const specifier = "ssh2";
    const mod = (await import(specifier)) as unknown as {
      Client: new () => Ssh2Client;
    };
    const client = new mod.Client();
    this.client = client;

    return new Promise((resolve, reject) => {
      client.on("ready", () => resolve({ presentedHostKeyFingerprint: this.presentedFingerprint }));
      client.on("error", reject);
      client.connect({
        host: parseHost(input.host),
        port: this.opts.port ?? 22,
        username: input.user,
        privateKey: input.privateKey,
        readyTimeout: this.opts.connectTimeoutMs ?? 20_000,
        // Capture the host key so the provider can TOFU-verify its fingerprint.
        // We accept it here (return true) and enforce the pin one layer up.
        hostVerifier: (keyOrHash: Buffer | string) => {
          const buf = typeof keyOrHash === "string" ? Buffer.from(keyOrHash, "base64") : keyOrHash;
          this.presentedFingerprint = "SHA256:" + createHash("sha256").update(buf).digest("base64").replace(/=+$/, "");
          return true;
        },
      });
    });
  }

  async exec(command: string): Promise<SshResult> {
    const client = this.client;
    if (!client) throw new Error("ssh not connected");
    return new Promise((resolve, reject) => {
      client.exec(command, (err, chan) => {
        if (err) {
          reject(err);
          return;
        }
        let stdout = "";
        let stderr = "";
        chan.on("data", (c) => (stdout += c.toString("utf8")));
        chan.stderr.on("data", (c) => (stderr += c.toString("utf8")));
        chan.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
      });
    });
  }

  // Verify the app over HTTP by curling it from inside the guest. Returns the
  // status code and body. The path is constrained to an absolute URL path.
  async httpGet(path: string): Promise<{ status: number; body: string }> {
    const safePath = path.startsWith("/") ? path : `/${path}`;
    const url = `http://127.0.0.1${safePath}`;
    // -s silent, -o body to stdout, -w status line at the end.
    const cmd = `curl -s -o - -w '\\n__FROLO_STATUS__%{http_code}' ${shellQuote(url)}`;
    const res = await this.exec(cmd);
    const marker = "__FROLO_STATUS__";
    const idx = res.stdout.lastIndexOf(marker);
    if (idx === -1) return { status: 0, body: res.stdout };
    const body = res.stdout.slice(0, idx).replace(/\n$/, "");
    const status = Number(res.stdout.slice(idx + marker.length).trim()) || 0;
    return { status, body };
  }

  async close(): Promise<void> {
    this.client?.end();
    this.client = null;
  }
}

function parseHost(host: string): string {
  // Accept bare IP/host or a URL-ish value; SSH wants just the hostname.
  try {
    if (host.includes("://")) return new URL(host).hostname;
  } catch {
    /* fall through */
  }
  return host;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
