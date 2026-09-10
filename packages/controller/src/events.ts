// Controller event bus (req §6.9, §17.2). The orchestrator emits sanitized
// events; the Electron main layer forwards them to the renderer over IPC.
// Events carry only serializable, already-sanitized data.

import type { DeploymentState } from "@frolo/contracts";

export type FroloEvent =
  | {
      type: "transition";
      deploymentId: string;
      from: DeploymentState | null;
      to: DeploymentState;
      reasonSanitized: string;
      at: string;
    }
  | {
      type: "log";
      deploymentId: string;
      level: "info" | "warn" | "error";
      messageSanitized: string;
      at: string;
    }
  | {
      type: "journal";
      deploymentId: string;
      action: string;
      status: string;
      at: string;
    }
  | {
      type: "exposure";
      deploymentId: string;
      hopIndex: number;
      phase: "applying" | "verified" | "rolled_back" | "removed";
      detailSanitized: string;
      at: string;
    };

export type EventListener = (e: FroloEvent) => void;

export class EventBus {
  private readonly listeners = new Set<EventListener>();

  subscribe(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: FroloEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // A listener error must never break orchestration.
      }
    }
  }
}
