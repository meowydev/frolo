// Provider interfaces — the boundaries (req §13.2). Fake and real implementations
// conform to these; the controller depends only on the interface.

import type {
  CapabilityReport,
  Ipv4,
  RecipeOperation,
  RecordedStep,
  TemplateInfo,
  VmInfo,
  Workflow,
} from "./domain.js";

// --- Proxmox ---------------------------------------------------------------
export interface TaskRef {
  node: string;
  upid: string;
}
export interface TaskResult {
  status: "running" | "ok" | "error";
  exitStatus?: string;
}

export interface CloneRequest {
  node: string;
  templateVmid: number;
  newVmid: number;
  name: string;
}
export interface ConfigureRequest {
  node: string;
  vmid: number;
  cores: number;
  ramMb: number;
  diskGb: number;
  hostname: string;
  // cloud-init network + user injection (mock models these)
  ipConfig: string; // e.g. "ip=dhcp" or "ip=10.0.0.5/24,gw=10.0.0.1"
  sshUser: string;
  sshPublicKey: string;
}

export interface ProxmoxProvider {
  validate(): Promise<CapabilityReport>;
  listTemplates(node: string): Promise<TemplateInfo[]>;
  listVms(node: string): Promise<VmInfo[]>;
  cloneTemplate(req: CloneRequest): Promise<TaskRef>;
  configureVm(req: ConfigureRequest): Promise<TaskRef>;
  startVm(node: string, vmid: number): Promise<TaskRef>;
  pollTask(ref: TaskRef): Promise<TaskResult>;
  deleteVm(node: string, vmid: number): Promise<TaskRef>;
  getGuestAddress(node: string, vmid: number): Promise<Ipv4 | null>;
  // Reconciliation helper (req §19): does the VM exist / is it configured?
  describeVm(node: string, vmid: number): Promise<VmInfo | null>;
}

// --- Guest -----------------------------------------------------------------
export interface GuestTarget {
  address: Ipv4;
  sshUser: string;
  privateKeyRef: string; // vault SecretRef, never inlined
  hostKeyFingerprint?: string; // pinned on first connect (TOFU)
  guestAgentAvailable: boolean;
}
export interface OpResult {
  ok: boolean;
  detailSanitized?: string;
}
export interface GuestProvider {
  waitReachable(target: GuestTarget, timeoutMs: number): Promise<void>;
  run(target: GuestTarget, op: RecipeOperation, asset?: string): Promise<OpResult>;
  httpGet(
    target: GuestTarget,
    path: string,
  ): Promise<{ status: number; body: string }>;
}

// --- Router ----------------------------------------------------------------
export interface RouterTrust {
  scheme: "http" | "https";
  pinnedCertFingerprint?: string;
}
export interface TeachSession {
  id: string;
  routerUrl: string;
}
export type VarBindings = Record<string, string>;

export interface RepairRequest {
  stepIndex: number;
  reason: "missing" | "ambiguous" | "manual";
  detail: string;
}
export interface ReplayReport {
  ok: boolean;
  stepsRun: number;
  repair?: RepairRequest;
  detailSanitized?: string;
}
export interface RuleExistence {
  exists: boolean;
  detailSanitized?: string;
}

export interface RouterProvider {
  openTeachWindow(routerUrl: string, trust: RouterTrust): Promise<TeachSession>;
  record(session: TeachSession): AsyncIterable<RecordedStep>;
  replay(
    workflow: Workflow,
    vars: VarBindings,
    trust: RouterTrust,
  ): Promise<ReplayReport>;
  probeRule(
    workflow: Workflow,
    vars: VarBindings,
    trust: RouterTrust,
  ): Promise<RuleExistence>;
}

// --- Vault -----------------------------------------------------------------
export interface VaultStatus {
  unlocked: boolean;
  recordCount: number;
  formatVersion: number;
}
export interface Vault {
  unlock(): Promise<void>;
  put(ref: string, value: string): Promise<void>;
  get(ref: string): Promise<string>;
  has(ref: string): Promise<boolean>;
  remove(ref: string): Promise<void>;
  status(): Promise<VaultStatus>;
}

// --- Keychain (master key store) -------------------------------------------
export interface KeychainAdapter {
  getKey(account: string): Promise<Buffer | null>;
  setKey(account: string, key: Buffer): Promise<void>;
  deleteKey(account: string): Promise<void>;
}

// --- Clock / Logger --------------------------------------------------------
export interface Clock {
  now(): Date;
  isoNow(): string;
}
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}
