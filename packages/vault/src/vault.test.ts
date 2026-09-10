import { describe, it, expect, beforeEach } from "vitest";
import { Aes256GcmVault, VaultCorruptError } from "./vault.js";
import { InMemoryFileStore } from "./file-store.js";
import { InMemoryKeychain } from "./keychain.js";
import { SecretRefs } from "./refs.js";

const PATH = "/tmp/frolo-test.vault";

describe("Aes256GcmVault", () => {
  let keychain: InMemoryKeychain;
  let store: InMemoryFileStore;

  beforeEach(() => {
    keychain = new InMemoryKeychain();
    store = new InMemoryFileStore();
  });

  it("round-trips a secret", async () => {
    const v = new Aes256GcmVault(PATH, keychain, store);
    await v.unlock();
    await v.put(SecretRefs.routerPassword("r1"), "s3cr3t-pass");
    expect(await v.get(SecretRefs.routerPassword("r1"))).toBe("s3cr3t-pass");
    expect(await v.has(SecretRefs.routerPassword("r1"))).toBe(true);
  });

  it("never stores plaintext in the file", async () => {
    const v = new Aes256GcmVault(PATH, keychain, store);
    await v.unlock();
    await v.put(SecretRefs.proxmoxToken("c1"), "PLAINTEXT-TOKEN-VALUE");
    const raw = await store.read(PATH);
    expect(raw).not.toContain("PLAINTEXT-TOKEN-VALUE");
    expect(raw).toContain("AES-256-GCM");
  });

  it("persists a random 256-bit key in the keychain, not the file", async () => {
    const v = new Aes256GcmVault(PATH, keychain, store);
    await v.unlock();
    const key = await keychain.getKey("frolo-master-key");
    expect(key).not.toBeNull();
    expect(key!.length).toBe(32);
    const raw = await store.read(PATH);
    expect(raw).not.toContain(key!.toString("base64"));
  });

  it("reopens with the same key across instances", async () => {
    const v1 = new Aes256GcmVault(PATH, keychain, store);
    await v1.unlock();
    await v1.put(SecretRefs.license(), "signed-license-blob");

    const v2 = new Aes256GcmVault(PATH, keychain, store);
    await v2.unlock();
    expect(await v2.get(SecretRefs.license())).toBe("signed-license-blob");
  });

  it("removes a secret with an atomic rewrite", async () => {
    const v = new Aes256GcmVault(PATH, keychain, store);
    await v.unlock();
    await v.put(SecretRefs.routerUsername("r1"), "admin");
    await v.remove(SecretRefs.routerUsername("r1"));
    expect(await v.has(SecretRefs.routerUsername("r1"))).toBe(false);
  });

  it("does not corrupt the vault on a crashed write", async () => {
    const v = new Aes256GcmVault(PATH, keychain, store);
    await v.unlock();
    await v.put(SecretRefs.routerPassword("r1"), "keep-me");

    store.failNextWrite = true;
    await expect(v.put(SecretRefs.routerPassword("r1"), "new")).rejects.toThrow();

    // Reopen: previous good value is intact.
    const v2 = new Aes256GcmVault(PATH, keychain, store);
    await v2.unlock();
    expect(await v2.get(SecretRefs.routerPassword("r1"))).toBe("keep-me");
  });

  it("rotates the key and preserves all secrets", async () => {
    const v = new Aes256GcmVault(PATH, keychain, store);
    await v.unlock();
    await v.put(SecretRefs.routerPassword("r1"), "p1");
    await v.put(SecretRefs.proxmoxToken("c1"), "t1");
    const before = await keychain.getKey("frolo-master-key");

    await v.rotateKey();
    const after = await keychain.getKey("frolo-master-key");
    expect(after!.equals(before!)).toBe(false); // key changed
    expect(await v.get(SecretRefs.routerPassword("r1"))).toBe("p1");
    expect(await v.get(SecretRefs.proxmoxToken("c1"))).toBe("t1");
  });

  it("fails closed on a corrupt vault file", async () => {
    await store.writeAtomic(PATH, "{ not valid json");
    const v = new Aes256GcmVault(PATH, keychain, store);
    await expect(v.unlock()).rejects.toThrow(VaultCorruptError);
  });

  it("reports locked status before unlock", async () => {
    const v = new Aes256GcmVault(PATH, keychain, store);
    const st = await v.status();
    expect(st.unlocked).toBe(false);
  });
});
