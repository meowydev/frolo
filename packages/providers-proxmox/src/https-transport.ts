// Real HTTPS transport for the Proxmox provider (Task 1). Uses Node's built-in
// `https` module — no third-party HTTP client — so there is no extra dependency
// and TLS behavior is fully under our control.
//
// Certificate pinning model (req: per-connection certificate pinning):
//  - TLS validation is ON by default (standard CA chain).
//  - If `pinnedCertSha256` is provided, we additionally require the server leaf
//    certificate's SHA-256 fingerprint to match. For self-signed homelab certs
//    the user first fetches + approves the fingerprint (see fetchCertFingerprint),
//    then all subsequent requests are pinned to it. We NEVER set a global
//    rejectUnauthorized=false; instead, when a pin is present we accept the
//    self-signed cert ONLY if its fingerprint matches the approved pin.
//  - The token secret is sent in the Authorization header and never logged.

import { request as httpsRequest, type RequestOptions } from "node:https";
import { createHash, type X509Certificate } from "node:crypto";
import { connect as tlsConnect } from "node:tls";
import type { HttpsTransport } from "./real.js";

export class TlsPinError extends Error {}

function sha256Fingerprint(der: Buffer): string {
  return createHash("sha256").update(der).digest("hex");
}

// Fetch the leaf certificate fingerprint from a host so the user can review and
// approve it during OOBE. Read-only: opens a TLS socket, reads the peer cert,
// and closes immediately. Does NOT validate against a CA (the point is to show
// the fingerprint of a possibly-self-signed cert for the user to pin).
export function fetchCertFingerprint(host: string): Promise<{ fingerprintSha256: string; subject?: string; issuer?: string; validTo?: string }> {
  const { hostname, port } = parseHost(host);
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      { host: hostname, port, servername: hostname, rejectUnauthorized: false, timeout: 10_000 },
      () => {
        const cert = socket.getPeerX509Certificate?.() as X509Certificate | undefined;
        if (!cert) {
          socket.destroy();
          reject(new Error("no peer certificate presented"));
          return;
        }
        const der = cert.raw;
        const result = {
          fingerprintSha256: sha256Fingerprint(der),
          subject: cert.subject,
          issuer: cert.issuer,
          validTo: cert.validTo,
        };
        socket.end();
        resolve(result);
      },
    );
    socket.on("error", reject);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("TLS connection timed out"));
    });
  });
}

// Node-native HTTPS transport implementing the provider's HttpsTransport seam.
export class NodeHttpsTransport implements HttpsTransport {
  constructor(private readonly timeoutMs = 30_000) {}

  request(input: {
    method: string;
    path: string; // absolute URL, e.g. https://pve:8006/api2/json/...
    headers: Record<string, string>;
    body?: string;
    pinnedCertSha256?: string;
  }): Promise<{ status: number; json: unknown; certSha256?: string }> {
    const url = new URL(input.path);
    const pinned = input.pinnedCertSha256?.toLowerCase();

    const options: RequestOptions = {
      method: input.method,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      headers: input.headers,
      timeout: this.timeoutMs,
      // When a pin is present we allow a self-signed cert but verify the pin
      // ourselves below (secureConnect). When no pin is present, keep full CA
      // validation on. We NEVER globally disable validation.
      rejectUnauthorized: pinned ? false : true,
      servername: url.hostname,
    };

    return new Promise((resolve, reject) => {
      const req = httpsRequest(options, (res) => {
        // Verify the certificate pin against the leaf cert fingerprint.
        let certSha256: string | undefined;
        const socket = res.socket as import("node:tls").TLSSocket;
        const cert = socket.getPeerX509Certificate?.() as X509Certificate | undefined;
        if (cert) certSha256 = sha256Fingerprint(cert.raw);
        if (pinned) {
          if (!certSha256 || certSha256.toLowerCase() !== pinned) {
            res.destroy();
            reject(new TlsPinError("server certificate fingerprint does not match the pinned value"));
            return;
          }
        }

        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown = undefined;
          if (text) {
            try {
              json = JSON.parse(text);
            } catch {
              json = { raw: text };
            }
          }
          resolve({ status: res.statusCode ?? 0, json, certSha256 });
        });
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("HTTPS request timed out"));
      });
      if (input.body) req.write(input.body);
      req.end();
    });
  }
}

function parseHost(host: string): { hostname: string; port: number } {
  try {
    const u = new URL(host.includes("://") ? host : `https://${host}`);
    return { hostname: u.hostname, port: Number(u.port) || 8006 };
  } catch {
    return { hostname: host, port: 8006 };
  }
}
