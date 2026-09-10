// IPC contract (req §17). The renderer reaches the controller ONLY through this
// fixed, typed set of channels exposed by the preload bridge. Main validates
// every payload and rejects unknown channels. All data here is serializable and
// already sanitized by the controller before it crosses the boundary.

import type {
  AuditEntry,
  Deployment,
  DeploymentLogLine,
  DeploymentTransition,
  ExposurePlan,
  HopMapping,
  JournalEntry,
  Mode,
  NetworkProfile,
  Recipe,
  RouterChain,
  RouterProfile,
  TemplateInfo,
  VmInfo,
} from "./domain.js";
import type { Entitlements } from "./licensing.js";

export interface PreviewPlanResult {
  deployment: Deployment;
  steps: string[];
  exposure?: ExposurePlan;
}

// The methods the preload bridge exposes on window.frolo. Each maps to one IPC
// channel. Keep this list closed; main rejects anything not here.
export interface FroloApi {
  getMode(): Promise<{ mode: Mode; realModeAvailable: boolean }>;

  listTemplates(): Promise<TemplateInfo[]>;
  listVms(): Promise<VmInfo[]>;
  listRecipes(): Promise<{ recipe: Recipe; checksum: string }[]>;

  createDeployment(plan: unknown): Promise<Deployment>;
  previewPlan(deploymentId: string): Promise<PreviewPlanResult>;
  runDeployment(deploymentId: string): Promise<Deployment>;
  retryDeployment(deploymentId: string): Promise<Deployment>;

  getDeployment(deploymentId: string): Promise<Deployment>;
  listDeployments(): Promise<Deployment[]>;
  listTransitions(deploymentId: string): Promise<DeploymentTransition[]>;
  listLogs(deploymentId: string): Promise<DeploymentLogLine[]>;
  listOperations(deploymentId: string): Promise<JournalEntry[]>;
  listMappings(
    deploymentId: string,
  ): Promise<(HopMapping & { applied: boolean; verified: boolean })[]>;

  confirmAndExpose(deploymentId: string): Promise<Deployment>;
  confirmAndDelete(
    deploymentId: string,
  ): Promise<{ deleted: boolean; detail: string }>;

  getEntitlements(): Promise<Entitlements>;
  getDeviceCode(): Promise<string>;
  installLicense(signedLicenseJson: string): Promise<Entitlements>;

  listAudit(): Promise<AuditEntry[]>;

  // Stage-2 breadth
  listNetworkProfiles(): Promise<NetworkProfile[]>;
  saveNetworkProfile(profile: unknown): Promise<void>;
  getRouterProfile(id: string): Promise<RouterProfile | null>;
  saveRouterProfile(profile: RouterProfile): Promise<void>;
  getRouterChain(id: string): Promise<RouterChain | null>;
  saveRouterChain(chain: RouterChain): Promise<void>;
  setRouterCredentials(routerProfileId: string, username: string, password: string): Promise<void>;
  vaultStatus(): Promise<{ unlocked: boolean; recordCount: number; formatVersion: number }>;

  // Live events: subscribe returns an unsubscribe function.
  onEvent(listener: (e: FroloUiEvent) => void): () => void;
}

// The subset of controller events forwarded to the UI. Mirrors controller
// FroloEvent but declared here so the renderer never imports the controller.
export type FroloUiEvent =
  | {
      type: "transition";
      deploymentId: string;
      from: string | null;
      to: string;
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
  | { type: "journal"; deploymentId: string; action: string; status: string; at: string }
  | {
      type: "exposure";
      deploymentId: string;
      hopIndex: number;
      phase: "applying" | "verified" | "rolled_back" | "removed";
      detailSanitized: string;
      at: string;
    };

// The canonical list of invoke channel names. Main registers exactly these.
export const IPC_CHANNELS = [
  "getMode",
  "listTemplates",
  "listVms",
  "listRecipes",
  "createDeployment",
  "previewPlan",
  "runDeployment",
  "retryDeployment",
  "getDeployment",
  "listDeployments",
  "listTransitions",
  "listLogs",
  "listOperations",
  "listMappings",
  "confirmAndExpose",
  "confirmAndDelete",
  "getEntitlements",
  "getDeviceCode",
  "installLicense",
  "listAudit",
  "listNetworkProfiles",
  "saveNetworkProfile",
  "getRouterProfile",
  "saveRouterProfile",
  "getRouterChain",
  "saveRouterChain",
  "setRouterCredentials",
  "vaultStatus",
] as const;
export type IpcChannel = (typeof IPC_CHANNELS)[number];

// Event push channel (main -> renderer).
export const FROLO_EVENT_CHANNEL = "frolo:event";
