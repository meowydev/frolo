// Operation journal service (req §19). Brackets every mutating Proxmox call in a
// journal entry, polls the task to result, and reconciles unresolved entries on
// startup so a crash never causes a duplicate mutation.

import type {
  JournalAction,
  JournalEntry,
  ProxmoxProvider,
  TaskRef,
  TaskResult,
} from "@frolo/contracts";
import type { FroloStore } from "@frolo/store";
import type { Sanitizer } from "@frolo/core";

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

export class JournalService {
  constructor(
    private readonly store: FroloStore,
    private readonly proxmox: ProxmoxProvider,
    private readonly sanitizer: Sanitizer,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  // Run a mutating operation idempotently. If the journal already records this
  // idempotency key as succeeded, the op is skipped (no duplicate). Otherwise
  // it issues the operation, records the UPID, polls to result, and records the
  // outcome. `issue` returns the TaskRef from the provider.
  async runMutation(input: {
    deploymentId: string;
    idempotencyKey: string;
    target: string;
    action: JournalAction;
    issue: () => Promise<TaskRef>;
    poll?: PollOptions;
  }): Promise<{ ok: boolean; detail: string; skipped: boolean }> {
    const existing = this.store.getOperationByKey(input.idempotencyKey);
    if (existing?.status === "succeeded") {
      return { ok: true, detail: "already completed (idempotent skip)", skipped: true };
    }
    if (existing?.status === "needs_attention") {
      return {
        ok: false,
        detail: "operation needs attention; not retried automatically",
        skipped: true,
      };
    }

    const entry = this.store.beginOperation({
      deploymentId: input.deploymentId,
      idempotencyKey: input.idempotencyKey,
      target: input.target,
      action: input.action,
    });

    let ref: TaskRef;
    try {
      ref = await input.issue();
    } catch (err) {
      const detail = this.sanitizer.sanitize(err);
      this.store.setOperationStatus(entry.id, "failed", detail);
      return { ok: false, detail, skipped: false };
    }

    this.store.setOperationUpid(entry.id, ref.upid);
    const result = await this.pollToResult(ref, input.poll);
    if (result.status === "ok") {
      this.store.setOperationStatus(entry.id, "succeeded", "task ok");
      return { ok: true, detail: `task ok (${ref.upid})`, skipped: false };
    }
    const detail = this.sanitizer.sanitize(result.exitStatus ?? "task failed");
    this.store.setOperationStatus(entry.id, "failed", detail);
    return { ok: false, detail, skipped: false };
  }

  private async pollToResult(ref: TaskRef, opts?: PollOptions): Promise<TaskResult> {
    const interval = opts?.intervalMs ?? 20;
    const timeout = opts?.timeoutMs ?? 10_000;
    const start = Date.now();
    for (;;) {
      const r = await this.proxmox.pollTask(ref);
      if (r.status !== "running") return r;
      if (Date.now() - start > timeout) {
        return { status: "error", exitStatus: "task poll timeout" };
      }
      await this.sleep(interval);
    }
  }

  // Startup reconciliation (req §19.4). For each unresolved entry, determine the
  // true outcome from the recorded UPID/target without issuing a new mutation.
  async reconcile(): Promise<JournalEntry[]> {
    const unresolved = this.store.listUnresolvedOperations();
    for (const op of unresolved) {
      try {
        // Prefer authoritative target-state inspection: after a crash/restart a
        // recorded task id may have aged out of Proxmox's task list, so an
        // "unknown task" poll must NOT be read as a real failure. Only trust the
        // UPID poll when it definitively reports ok, or an error that is NOT the
        // "unknown task" sentinel.
        const byTarget = await this.reconcileByTarget(op);
        if (byTarget === "succeeded") {
          this.store.setOperationStatus(op.id, "succeeded", "reconciled by target state");
          continue;
        }
        if (op.upid) {
          const r = await this.proxmox.pollTask({ node: nodeFromUpid(op.upid), upid: op.upid });
          if (r.status === "ok") {
            this.store.setOperationStatus(op.id, "succeeded", "reconciled: task ok");
            continue;
          }
          if (r.status === "error" && !isUnknownTask(r.exitStatus)) {
            this.store.setOperationStatus(op.id, "failed", "reconciled: task error");
            continue;
          }
        }
        // Target inspection is the fallback authority. (byTarget cannot be
        // "succeeded" here — that was handled above.)
        if (byTarget === "failed") {
          this.store.setOperationStatus(op.id, "failed", "reconciled: target absent");
        } else {
          this.store.setOperationStatus(
            op.id,
            "needs_attention",
            "could not determine outcome; needs user attention",
          );
        }
      } catch (err) {
        this.store.setOperationStatus(
          op.id,
          "needs_attention",
          this.sanitizer.sanitize(err),
        );
      }
    }
    return this.store.listUnresolvedOperations();
  }

  // Inspect the target resource to infer the outcome (req §19.4).
  private async reconcileByTarget(
    op: JournalEntry,
  ): Promise<"succeeded" | "failed" | "unknown"> {
    const parsed = parseTarget(op.target);
    if (!parsed) return "unknown";
    const vm = await this.proxmox.describeVm(parsed.node, parsed.vmid);
    switch (op.action) {
      case "clone":
        // If the VM exists, the clone effectively succeeded.
        return vm ? "succeeded" : "failed";
      case "delete":
        // If the VM is gone, the delete succeeded.
        return vm ? "unknown" : "succeeded";
      case "configure":
      case "start":
        // Cannot verify config/run precisely from describeVm alone.
        return vm ? "unknown" : "failed";
      default:
        return "unknown";
    }
  }
}

function isUnknownTask(exitStatus?: string): boolean {
  return (exitStatus ?? "").toLowerCase().includes("unknown task");
}

function nodeFromUpid(upid: string): string {
  // UPID format: UPID:<node>:<...>
  const parts = upid.split(":");
  return parts[1] ?? "pve";
}

function parseTarget(target: string): { node: string; vmid: number } | null {
  // target format: "<node>/<vmid>"
  const [node, vmidStr] = target.split("/");
  if (!node || !vmidStr) return null;
  const vmid = Number(vmidStr);
  if (!Number.isInteger(vmid)) return null;
  return { node, vmid };
}
