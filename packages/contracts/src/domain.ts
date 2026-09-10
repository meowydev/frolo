// Frolo domain types — shared, serializable, no I/O, no secrets.

export type Mode = "mock" | "real";

export type Ipv4 = string;

// ---------------------------------------------------------------------------
// Deployment state machine (req §6)
// ---------------------------------------------------------------------------
export const DEPLOYMENT_STATES = [
  "Queued",
  "Cloning",
  "Configuring",
  "Booting",
  "Installing",
  "Checking",
  "Exposing",
  "Ready",
  "Failed",
] as const;
export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];

export interface DeploymentTransition {
  id: string;
  deploymentId: string;
  from: DeploymentState | null;
  to: DeploymentState;
  reasonSanitized: string;
  at: string; // ISO timestamp
}

// ---------------------------------------------------------------------------
// Proxmox inventory (req §3)
// ---------------------------------------------------------------------------
export type ProxmoxEntryKind = "qemu-template" | "qemu-vm" | "lxc";

export interface TemplateInfo {
  vmid: number;
  name: string;
  kind: ProxmoxEntryKind;
  cloudInit: boolean;
  osHint?: string;
}

export interface VmInfo {
  vmid: number;
  name: string;
  status: "running" | "stopped" | "unknown";
  cores?: number;
  ramMb?: number;
  diskGb?: number;
}

export interface CapabilityReport {
  ok: boolean;
  node: string;
  canClone: boolean;
  canConfigure: boolean;
  canStart: boolean;
  canDelete: boolean;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Networking (req §4)
// ---------------------------------------------------------------------------
export type NetworkMode = "dhcp" | "manual" | "vmid";

export interface NetworkProfile {
  id: string;
  name: string;
  mode: NetworkMode;
  subnetCidr?: string; // required for manual + vmid
  gateway?: string; // required for manual
  address?: Ipv4; // required for manual
  vmidRule?: VmidRule; // required for vmid
}

// Deterministic VM-ID -> IPv4 rule: address = baseHostFromCidr + (vmid % span) + offset
export interface VmidRule {
  // Host part is computed as: (vmid + offset) constrained to the subnet's host range.
  offset: number;
}

export interface ResolvedNetwork {
  mode: NetworkMode;
  address?: Ipv4; // undefined for dhcp until readback
  gateway?: Ipv4;
  prefix?: number; // CIDR prefix length
  requiresGuestAgent: boolean; // true for dhcp readback (req §18.7)
}

// ---------------------------------------------------------------------------
// Recipes (req §5)
// ---------------------------------------------------------------------------
export type RecipeOperation =
  | { type: "pkg.install"; packages: string[] }
  | { type: "file.write"; path: string; contentRef: string; mode?: string }
  | { type: "service.enable"; name: string }
  | { type: "service.start"; name: string }
  | {
      type: "http.check";
      path: string;
      expectStatus: number;
      expectContains: string;
    };

export type RecipeOperationType = RecipeOperation["type"];

export interface RecipeConstraints {
  writablePaths: string[];
  packages: string[];
  services: string[];
}

export interface Recipe {
  id: string;
  name: string;
  version: string;
  source: "builtin";
  operations: RecipeOperation[];
  constraints: RecipeConstraints;
  // Bundled assets referenced by file.write contentRef.
  assets: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Teach Mode workflows (req §8, §9)
// ---------------------------------------------------------------------------
export type Locator =
  | { by: "role"; role: string; name?: string }
  | { by: "label"; text: string }
  | { by: "id"; value: string; generated: boolean }
  | { by: "name"; value: string }
  | { by: "dataAttr"; attr: string; value: string }
  | { by: "nearbyText"; text: string; relation: "heading" | "row" }
  | { by: "domPath"; path: string }
  | { by: "coordinates"; x: number; y: number; lastResort: true };

export type StepKind =
  | "navigate"
  | "click"
  | "fill"
  | "fillSecret"
  | "select"
  | "check"
  | "enterFrame"
  | "waitLoad"
  | "confirmDialog"
  | "expectSuccess"
  | "verifyRule"
  | "manualCheckpoint";

export type VarName =
  | "router_username"
  | "router_password"
  | "internal_ip"
  | "internal_port"
  | "external_port"
  | "protocol"
  | "rule_name";

export type FieldBinding =
  | { kind: "fixed"; value: string }
  | { kind: "var"; name: VarName }
  | { kind: "ask" };

export interface RecordedStep {
  kind: StepKind;
  locators: Locator[];
  binding?: FieldBinding;
  meta: { url?: string; frame?: string; note?: string; manualReason?: string };
}

export type WorkflowKind = "login" | "create" | "find" | "delete";

export interface Workflow {
  id: string;
  routerProfileId: string;
  kind: WorkflowKind;
  version: number;
  steps: RecordedStep[];
}

// ---------------------------------------------------------------------------
// Router chains & exposure (req §10)
// ---------------------------------------------------------------------------
export type Protocol = "tcp" | "udp";

export interface RouterProfile {
  id: string;
  name: string;
  baseUrl: string;
  scheme: "http" | "https";
  pinnedCertFingerprint?: string;
  kind: "fixtureA" | "fixtureB" | "real";
}

export interface ChainHop {
  routerProfileId: string;
  wanAddress: Ipv4; // WAN address of this router (simulated in mock)
}

export interface RouterChain {
  id: string;
  name: string;
  // Ordered innermost (nearest VM) -> outermost (internet edge).
  hops: ChainHop[];
}

// A single port-forward mapping as an explicit five-tuple (req §10.3).
export interface HopMapping {
  hopIndex: number;
  routerProfileId: string;
  listenAddress: Ipv4;
  listenPort: number;
  targetAddress: Ipv4;
  targetPort: number;
  protocol: Protocol;
}

export interface ExposurePlan {
  protocol: Protocol;
  publicPort: number;
  internalPort: number;
  vmAddress: Ipv4;
  hops: HopMapping[];
  publicAddress: Ipv4; // outermost WAN:publicPort (simulated in mock)
}

// ---------------------------------------------------------------------------
// Operation journal (req §19)
// ---------------------------------------------------------------------------
export type JournalAction =
  | "clone"
  | "configure"
  | "start"
  | "delete"
  | "map_apply"
  | "map_delete";

export type JournalStatus =
  | "pending"
  | "in_flight"
  | "succeeded"
  | "failed"
  | "needs_attention";

export interface JournalEntry {
  id: string;
  deploymentId: string;
  idempotencyKey: string;
  target: string;
  action: JournalAction;
  upid?: string;
  status: JournalStatus;
  startedAt: string;
  observedResultSanitized?: string;
  reconciledAt?: string;
}

// ---------------------------------------------------------------------------
// Deployment aggregate (req §6, §7)
// ---------------------------------------------------------------------------
export interface DeploymentPlan {
  name: string;
  connectionId: string;
  templateVmid: number;
  cores: number;
  ramMb: number;
  diskGb: number;
  hostname: string;
  sshUser: string;
  networkProfileId: string;
  recipeId: string;
  chainId?: string;
  exposure?: { protocol: Protocol; publicPort: number; internalPort: number };
}

export interface Deployment {
  id: string;
  plan: DeploymentPlan;
  state: DeploymentState;
  targetVmid?: number;
  localAddress?: Ipv4;
  publicAddressSim?: Ipv4;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentLogLine {
  id: string;
  deploymentId: string;
  level: "info" | "warn" | "error";
  messageSanitized: string;
  at: string;
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  subject: string;
  detailSanitized: string;
  at: string;
}
