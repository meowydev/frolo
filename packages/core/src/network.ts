// Network address resolution (req §4). Pure functions: DHCP, manual, and
// VM-ID-derived IPv4, with subnet validation.

import type { NetworkProfile, ResolvedNetwork } from "@frolo/contracts";

export interface CidrParts {
  network: number; // 32-bit unsigned
  prefix: number;
  broadcast: number;
  firstHost: number;
  lastHost: number;
}

export function ipToInt(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) throw new Error(`Invalid IPv4: ${ip}`);
  let n = 0;
  for (const p of parts) {
    const octet = Number(p);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      throw new Error(`Invalid IPv4 octet in ${ip}`);
    }
    n = (n << 8) | octet;
  }
  return n >>> 0;
}

export function intToIp(n: number): string {
  return [
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ].join(".");
}

export function parseCidr(cidr: string): CidrParts {
  const [addr, prefixStr] = cidr.split("/");
  if (!addr || prefixStr === undefined) throw new Error(`Invalid CIDR: ${cidr}`);
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid CIDR prefix: ${cidr}`);
  }
  const ip = ipToInt(addr);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ip & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  // For prefixes that leave room for hosts, exclude network+broadcast.
  const hasHostRange = prefix <= 30;
  const firstHost = hasHostRange ? (network + 1) >>> 0 : network;
  const lastHost = hasHostRange ? (broadcast - 1) >>> 0 : broadcast;
  return { network, prefix, broadcast, firstHost, lastHost };
}

export function isInSubnet(ip: string, cidr: string): boolean {
  const { network, broadcast } = parseCidr(cidr);
  const n = ipToInt(ip);
  return n >= network && n <= broadcast;
}

export function isUsableHost(ip: string, cidr: string): boolean {
  const { firstHost, lastHost } = parseCidr(cidr);
  const n = ipToInt(ip);
  return n >= firstHost && n <= lastHost;
}

// Resolve a network profile to a concrete plan for a given VM-ID.
// For DHCP, address is undefined until readback (req §4.5) and the guest agent
// is required (req §18.7).
export function resolveNetwork(
  profile: NetworkProfile,
  vmid: number,
): ResolvedNetwork {
  switch (profile.mode) {
    case "dhcp":
      return { mode: "dhcp", requiresGuestAgent: true };

    case "manual": {
      if (!profile.address || !profile.gateway || !profile.subnetCidr) {
        throw new Error("manual network requires address, gateway, subnetCidr");
      }
      if (!isUsableHost(profile.address, profile.subnetCidr)) {
        throw new Error(
          `manual address ${profile.address} is not a usable host in ${profile.subnetCidr}`,
        );
      }
      const { prefix } = parseCidr(profile.subnetCidr);
      return {
        mode: "manual",
        address: profile.address,
        gateway: profile.gateway,
        prefix,
        requiresGuestAgent: false,
      };
    }

    case "vmid": {
      if (!profile.subnetCidr || !profile.vmidRule) {
        throw new Error("vmid network requires subnetCidr and vmidRule");
      }
      const cidr = parseCidr(profile.subnetCidr);
      const span = cidr.lastHost - cidr.firstHost + 1;
      if (span <= 0) throw new Error("subnet has no usable host range");
      const raw = vmid + profile.vmidRule.offset;
      // Map deterministically into the usable host range.
      const host = (cidr.firstHost + (mod(raw, span))) >>> 0;
      const address = intToIp(host);
      if (!isUsableHost(address, profile.subnetCidr)) {
        throw new Error(
          `derived address ${address} is not within ${profile.subnetCidr}`,
        );
      }
      return {
        mode: "vmid",
        address,
        gateway: profile.gateway,
        prefix: cidr.prefix,
        requiresGuestAgent: false,
      };
    }
  }
}

// Build the Proxmox cloud-init ipconfig string.
export function toIpConfig(net: ResolvedNetwork): string {
  if (net.mode === "dhcp" || !net.address) return "ip=dhcp";
  const gwPart = net.gateway ? `,gw=${net.gateway}` : "";
  return `ip=${net.address}/${net.prefix ?? 24}${gwPart}`;
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}
