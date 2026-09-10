import { describe, it, expect, afterAll } from "vitest";
import { createServer, type Server } from "node:https";
import { createHash, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHttpsTransport, TlsPinError, fetchCertFingerprint } from "./https-transport.js";
import { RealProxmoxProvider, CertificatePinMismatch } from "./real.js";

// Generate a throwaway self-signed cert with openssl in a temp dir. Returns null
// if openssl is unavailable (test degrades to a construction check). This never
// touches a real Proxmox host — the server is a local 127.0.0.1 stub.
function makeSelfSigned(): { keyPem: string; certPem: string; fingerprint: string; dir: string } | null {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "frolo-tls-"));
    const key = join(dir, "k.pem");
    const cert = join(dir, "c.pem");
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1"],
      { stdio: "ignore" },
    );
    const certPem = readFileSync(cert, "utf8");
    const der = new X509Certificate(certPem).raw;
    const fingerprint = createHash("sha256").update(der).digest("hex");
    return { keyPem: readFileSync(key, "utf8"), certPem, fingerprint, dir };
  } catch {
    if (dir) rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

let server: Server | undefined;
let tempDir: string | undefined;
afterAll(() => {
  server?.close();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe("NodeHttpsTransport certificate pinning", () => {
  it("accepts a matching pin and rejects a mismatched pin (live local TLS)", async () => {
    const tls = makeSelfSigned();
    if (!tls) {
      // No openssl in this environment — assert construction and skip live test.
      expect(new NodeHttpsTransport()).toBeTruthy();
      return;
    }
    tempDir = tls.dir;

    server = createServer({ key: tls.keyPem, cert: tls.certPem }, (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { ok: true } }));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server!.address() as { port: number }).port;
    const url = `https://127.0.0.1:${port}/api2/json/x`;
    const transport = new NodeHttpsTransport();

    const good = await transport.request({ method: "GET", path: url, headers: {}, pinnedCertSha256: tls.fingerprint });
    expect(good.status).toBe(200);
    expect(good.certSha256?.toLowerCase()).toBe(tls.fingerprint.toLowerCase());

    await expect(
      transport.request({ method: "GET", path: url, headers: {}, pinnedCertSha256: "00".repeat(32) }),
    ).rejects.toBeInstanceOf(TlsPinError);

    const info = await fetchCertFingerprint(`127.0.0.1:${port}`);
    expect(info.fingerprintSha256.toLowerCase()).toBe(tls.fingerprint.toLowerCase());
  });
});

describe("RealProxmoxProvider defense-in-depth pin check", () => {
  it("throws CertificatePinMismatch when the transport reports a different cert", async () => {
    const provider = new RealProxmoxProvider(
      { host: "https://pve.invalid:8006", node: "pve", tokenId: "t", tokenSecret: "s", pinnedCertSha256: "expected" },
      { request: async () => ({ status: 200, json: { data: {} }, certSha256: "actual-different" }) },
    );
    await expect(provider.validate()).rejects.toBeInstanceOf(CertificatePinMismatch);
  });
});
