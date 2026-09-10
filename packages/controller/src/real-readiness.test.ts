import { describe, it, expect } from "vitest";
import { realModeReadiness } from "./real-readiness.js";
import { composeReal } from "./compose-real.js";
import { composeMock } from "./compose-mock.js";

describe("real-mode readiness gate (req §1.1)", () => {
  it("is closed by default (real mode hidden)", () => {
    expect(realModeReadiness({}).available).toBe(false);
  });

  it("stays closed if opted in but safety tests not recorded as passing", () => {
    expect(realModeReadiness({ FROLO_ENABLE_REAL_MODE: "1" }).available).toBe(false);
  });

  it("opens only when opted in AND safety tests recorded as passing", () => {
    const r = realModeReadiness({ FROLO_ENABLE_REAL_MODE: "1", FROLO_REAL_SAFETY_TESTS_PASSED: "1" });
    expect(r.available).toBe(true);
  });
});

describe("controller reports real mode hidden by default", () => {
  it("getMode has realModeAvailable=false in mock composition", async () => {
    const c = await composeMock();
    expect(c.controller.getMode().realModeAvailable).toBe(false);
  });
});

describe("composeReal refuses to build when the gate is closed", () => {
  it("throws with a clear reason and opens no connection", async () => {
    await expect(
      composeReal({
        storePath: ":memory:",
        vaultPath: "/tmp/should-never-be-created.vault",
        proxmox: {
          connectionId: "c1",
          host: "https://pve.invalid",
          node: "pve",
          tokenId: "frolo@pve!x",
        },
        // Transports that would throw if ever called — proving no connection is made.
        httpsTransport: { request: async () => { throw new Error("should not connect"); } },
        sshTransport: {
          connect: async () => { throw new Error("should not connect"); },
          exec: async () => { throw new Error("no"); },
          httpGet: async () => { throw new Error("no"); },
          close: async () => {},
        },
        openPageDriver: async () => { throw new Error("should not open browser"); },
        licenseKeys: [],
        readiness: () => ({ available: false, reason: "closed for test" }),
      }),
    ).rejects.toThrow(/real mode is not available/);
  });
});
