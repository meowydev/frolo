// SSH key generation for guest access (req §18.2). The real implementation
// (Phase 8) uses ed25519 keypairs and computes the guest host-key fingerprint
// after first connect. The fake produces deterministic-looking material without
// real key ceremony so the trust flow (store private key in vault, TOFU pin)
// can be exercised in mock mode. The fake NEVER emits usable credentials.

import { randomBytes, generateKeyPairSync, createPublicKey, type KeyObject } from "node:crypto";
import type { KeyGenerator } from "./deps.js";

export class FakeKeyGenerator implements KeyGenerator {
  generate(deploymentId: string) {
    const id = randomBytes(6).toString("hex");
    return {
      // Clearly-fake, non-usable placeholder private key.
      privateKey: `FAKE-PRIVATE-KEY-do-not-use-${deploymentId}-${id}`,
      publicKey: `ssh-ed25519 AAAAFAKE${id} frolo-${deploymentId}`,
      // The fake guest presents this exact host key on first connect.
      expectedHostKeyFingerprint: "SHA256:fake-host-key",
    };
  }
}

// Real ed25519 key generation for Phase 8. Generates a genuine keypair; the
// private key is placed in the vault by the caller and never logged. The host
// key fingerprint is LEARNED on first connect (TOFU), not predicted, so the
// expected value is empty until the guest is first reached.
export class RealKeyGenerator implements KeyGenerator {
  generate(deploymentId: string): {
    privateKey: string;
    publicKey: string;
    expectedHostKeyFingerprint: string;
  } {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { format: "pem", type: "spki" },
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
    });
    return {
      // PKCS8 PEM private key — accepted directly by ssh2 for authentication.
      privateKey: privateKey.toString(),
      // OpenSSH-format public key ("ssh-ed25519 AAAA... comment") so cloud-init
      // can drop it straight into the guest's authorized_keys. sshd rejects PEM
      // SPKI, so we must emit the OpenSSH wire format here (the server IS the
      // app now — there is no separate desktop layer to convert it).
      publicKey: toOpenSshEd25519(
        createPublicKey({ key: publicKey.toString(), format: "pem", type: "spki" }),
        `frolo-${deploymentId}`,
      ),
      // TOFU: pin on first connect rather than predict (empty = "not yet pinned").
      expectedHostKeyFingerprint: "",
    };
  }
}

// Encode an ed25519 public KeyObject as an OpenSSH authorized_keys line.
// Wire format: string("ssh-ed25519") || string(raw 32-byte key), each field
// length-prefixed with a 4-byte big-endian length; then base64 it.
export function toOpenSshEd25519(pub: KeyObject, comment = ""): string {
  const der = pub.export({ format: "der", type: "spki" }) as Buffer;
  // ed25519 SPKI DER is a fixed 44 bytes; the raw key is the trailing 32 bytes.
  const raw = der.subarray(der.length - 32);
  const algo = Buffer.from("ssh-ed25519", "ascii");
  const wire = Buffer.concat([lenPrefixed(algo), lenPrefixed(raw)]);
  const b64 = wire.toString("base64");
  return `ssh-ed25519 ${b64}${comment ? ` ${comment}` : ""}`;
}

function lenPrefixed(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}
