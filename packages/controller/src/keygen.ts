// SSH key generation for guest access (req §18.2). The real implementation
// (Phase 8) uses ed25519 keypairs and computes the guest host-key fingerprint
// after first connect. The fake produces deterministic-looking material without
// real key ceremony so the trust flow (store private key in vault, TOFU pin)
// can be exercised in mock mode. The fake NEVER emits usable credentials.

import { randomBytes, generateKeyPairSync } from "node:crypto";
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
  generate(_deploymentId: string): {
    privateKey: string;
    publicKey: string;
    expectedHostKeyFingerprint: string;
  } {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { format: "pem", type: "spki" },
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
    });
    return {
      privateKey: privateKey.toString(),
      // Note: real SSH deployments format this as an OpenSSH public key; the
      // desktop app performs that conversion. Kept as PEM here for the seam.
      publicKey: publicKey.toString(),
      // TOFU: pin on first connect rather than predict (empty = "not yet pinned").
      expectedHostKeyFingerprint: "",
    };
  }
}
