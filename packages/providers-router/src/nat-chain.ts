// Simulated NAT chain (req §14.5, §10.8). An in-memory model of routers, each
// holding forwarding rules. A reachability probe walks the chain from the
// public (outermost) address inward and confirms a request resolves to the VM.

import type { ExposurePlan, HopMapping } from "@frolo/contracts";

interface Forward {
  listenAddress: string;
  listenPort: number;
  targetAddress: string;
  targetPort: number;
  protocol: string;
}

export class SimulatedNatChain {
  // routerProfileId -> its applied forwards
  private readonly forwards = new Map<string, Forward[]>();
  // the address of the VM itself (innermost target)
  constructor(private readonly vmAddress: string) {}

  apply(m: HopMapping): void {
    const list = this.forwards.get(m.routerProfileId) ?? [];
    list.push({
      listenAddress: m.listenAddress,
      listenPort: m.listenPort,
      targetAddress: m.targetAddress,
      targetPort: m.targetPort,
      protocol: m.protocol,
    });
    this.forwards.set(m.routerProfileId, list);
  }

  remove(m: HopMapping): void {
    const list = this.forwards.get(m.routerProfileId) ?? [];
    this.forwards.set(
      m.routerProfileId,
      list.filter(
        (f) =>
          !(
            f.listenAddress === m.listenAddress &&
            f.listenPort === m.listenPort &&
            f.targetAddress === m.targetAddress
          ),
      ),
    );
  }

  // Walk the chain: start at the public address:port, follow each router's
  // forward whose listen matches, until we reach the VM. Returns true if a
  // request to the public address would reach the VM.
  probe(plan: ExposurePlan): boolean {
    const [pubAddr, pubPortStr] = plan.publicAddress.split(":");
    let addr = pubAddr!;
    let port = Number(pubPortStr);

    // Order routers outermost -> innermost by hopIndex descending.
    const orderedHops = [...plan.hops].sort((a, b) => b.hopIndex - a.hopIndex);
    for (const hop of orderedHops) {
      const list = this.forwards.get(hop.routerProfileId) ?? [];
      const match = list.find(
        (f) =>
          f.listenAddress === addr &&
          f.listenPort === port &&
          f.protocol === plan.protocol,
      );
      if (!match) return false;
      addr = match.targetAddress;
      port = match.targetPort;
    }
    // After the innermost hop we should be pointed at the VM.
    return addr === this.vmAddress && port === plan.internalPort;
  }

  ruleCount(): number {
    let n = 0;
    for (const list of this.forwards.values()) n += list.length;
    return n;
  }
}
