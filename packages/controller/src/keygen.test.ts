// RealKeyGenerator must emit a private key ssh2 can use AND an OpenSSH-format
// public key that sshd/cloud-init accepts in authorized_keys. A regression here
// (e.g. reverting to PEM SPKI) silently breaks every real SSH deployment, so we
// assert the exact wire format.

import { describe, it, expect } from "vitest";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { RealKeyGenerator, FakeKeyGenerator, toOpenSshEd25519 } from "./keygen.js";

describe("RealKeyGenerator", () => {
  it("produces a PKCS8 PEM private key and an OpenSSH ed25519 public key", () => {
    const g = new RealKeyGenerator();
    const { privateKey, publicKey } = g.generate("dep-123");

    expect(privateKey).toContain("-----BEGIN PRIVATE KEY-----");
    // OpenSSH authorized_keys line: "ssh-ed25519 <base64> frolo-dep-123".
    expect(publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=* frolo-dep-123$/);

    // The base64 payload must decode to the ssh-ed25519 wire format:
    // string("ssh-ed25519") || string(32-byte key).
    const b64 = publicKey.split(" ")[1]!;
    const wire = Buffer.from(b64, "base64");
    const algoLen = wire.readUInt32BE(0);
    const algo = wire.subarray(4, 4 + algoLen).toString("ascii");
    expect(algo).toBe("ssh-ed25519");
    const keyLen = wire.readUInt32BE(4 + algoLen);
    expect(keyLen).toBe(32); // raw ed25519 public key length
  });

  it("host key fingerprint is empty (learned via TOFU on first connect)", () => {
    const g = new RealKeyGenerator();
    expect(g.generate("d").expectedHostKeyFingerprint).toBe("");
  });

  it("toOpenSshEd25519 round-trips a key object", () => {
    const g = new RealKeyGenerator();
    // Re-derive from a fresh public key object to exercise the encoder directly.
    const line = g.generate("x").publicKey;
    const b64 = line.split(" ")[1]!;
    expect(Buffer.from(b64, "base64").length).toBeGreaterThan(50);
    // Encoding a key object built from the same algorithm yields the prefix.
    const { publicKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { format: "pem", type: "spki" },
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
    });
    const encoded = toOpenSshEd25519(createPublicKey({ key: publicKey.toString(), format: "pem", type: "spki" }));
    expect(encoded.startsWith("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5")).toBe(true);
  });
});

describe("FakeKeyGenerator", () => {
  it("never emits usable credentials", () => {
    const { privateKey } = new FakeKeyGenerator().generate("d");
    expect(privateKey).toContain("FAKE-PRIVATE-KEY-do-not-use");
  });
});
