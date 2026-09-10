import { describe, it, expect } from "vitest";
import type { NetworkProfile } from "@frolo/contracts";
import {
  ipToInt,
  intToIp,
  parseCidr,
  isInSubnet,
  isUsableHost,
  resolveNetwork,
  toIpConfig,
} from "./network.js";

describe("network math", () => {
  it("round-trips ip <-> int", () => {
    expect(intToIp(ipToInt("192.168.1.10"))).toBe("192.168.1.10");
    expect(intToIp(ipToInt("10.0.0.1"))).toBe("10.0.0.1");
  });

  it("parses CIDR host ranges", () => {
    const c = parseCidr("192.168.1.0/24");
    expect(intToIp(c.firstHost)).toBe("192.168.1.1");
    expect(intToIp(c.lastHost)).toBe("192.168.1.254");
  });

  it("checks subnet membership", () => {
    expect(isInSubnet("192.168.1.50", "192.168.1.0/24")).toBe(true);
    expect(isInSubnet("192.168.2.50", "192.168.1.0/24")).toBe(false);
    expect(isUsableHost("192.168.1.255", "192.168.1.0/24")).toBe(false); // broadcast
    expect(isUsableHost("192.168.1.0", "192.168.1.0/24")).toBe(false); // network
  });
});

describe("resolveNetwork", () => {
  it("resolves DHCP and requires guest agent", () => {
    const p: NetworkProfile = { id: "n", name: "dhcp", mode: "dhcp" };
    const r = resolveNetwork(p, 101);
    expect(r.mode).toBe("dhcp");
    expect(r.requiresGuestAgent).toBe(true);
    expect(toIpConfig(r)).toBe("ip=dhcp");
  });

  it("resolves manual and validates subnet membership", () => {
    const p: NetworkProfile = {
      id: "n",
      name: "manual",
      mode: "manual",
      address: "10.0.0.5",
      gateway: "10.0.0.1",
      subnetCidr: "10.0.0.0/24",
    };
    const r = resolveNetwork(p, 101);
    expect(r.address).toBe("10.0.0.5");
    expect(toIpConfig(r)).toBe("ip=10.0.0.5/24,gw=10.0.0.1");
  });

  it("rejects manual address outside subnet", () => {
    const p: NetworkProfile = {
      id: "n",
      name: "bad",
      mode: "manual",
      address: "10.0.9.5",
      gateway: "10.0.0.1",
      subnetCidr: "10.0.0.0/24",
    };
    expect(() => resolveNetwork(p, 101)).toThrow();
  });

  it("derives a deterministic VM-ID address within the subnet", () => {
    const p: NetworkProfile = {
      id: "n",
      name: "vmid",
      mode: "vmid",
      subnetCidr: "10.0.0.0/24",
      gateway: "10.0.0.1",
      vmidRule: { offset: 0 },
    };
    const a = resolveNetwork(p, 5);
    const b = resolveNetwork(p, 5);
    expect(a.address).toBe(b.address); // deterministic
    expect(isUsableHost(a.address!, "10.0.0.0/24")).toBe(true);
  });
});
