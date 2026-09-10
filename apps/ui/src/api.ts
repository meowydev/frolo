// HTTP API client for the Frolo web panel. Replaces the former Electron preload
// bridge with fetch + EventSource against the authenticated Fastify API on the
// same origin. Handles the CSRF double-submit cookie automatically for mutations.

import type {
  AuditEntry,
  Deployment,
  DeploymentLogLine,
  DeploymentTransition,
  Entitlements,
  HopMapping,
  JournalEntry,
  NetworkProfile,
  Recipe,
  RouterChain,
  RouterProfile,
  TemplateInfo,
  VmInfo,
  FroloUiEvent,
  PreviewPlanResult,
} from "@frolo/contracts";

const CSRF_COOKIE = "frolo_csrf";
const CSRF_HEADER = "x-frolo-csrf";

function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]!) : null;
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && method !== "HEAD") {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers[CSRF_HEADER] = csrf;
  }
  const res = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    throw new ApiError(res.status, (data && data.error) || res.statusText);
  }
  return data as T;
}

export interface AuthState {
  hasAccount: boolean;
  setupComplete: boolean;
}
export interface Info {
  version: string;
  beta: boolean;
  behindTls: boolean;
}
export interface SetupState {
  completed: boolean;
  progress: Record<string, unknown>;
  hasAccount: boolean;
}

export const api = {
  // --- meta / auth ---
  info: () => request<Info>("GET", "/api/info"),
  health: () => request<{ status: string; version: string; mode: string }>("GET", "/api/health"),
  authState: () => request<AuthState>("GET", "/api/auth/state"),
  me: () => request<{ account: { id: string; username: string; role: string } | null }>("GET", "/api/auth/me"),
  login: (username: string, password: string) =>
    request<{ account: { id: string; username: string; role: string } }>("POST", "/api/auth/login", { username, password }),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout"),

  // --- setup / OOBE ---
  setupState: () => request<SetupState>("GET", "/api/setup/state"),
  saveProgress: (progress: Record<string, unknown>) =>
    request<{ ok: true; progress: Record<string, unknown> }>("POST", "/api/setup/progress", { progress }),
  createAdmin: (username: string, password: string) =>
    request<{ account: { id: string; username: string; role: string }; recoveryCode: string }>(
      "POST",
      "/api/setup/create-admin",
      { username, password },
    ),
  confirmRecovery: () => request<{ ok: true }>("POST", "/api/setup/confirm-recovery", { acknowledged: true }),
  tryMock: () => request<{ ok: true; mode: string }>("POST", "/api/setup/try-mock"),
  validateProxmox: (input: {
    host?: string;
    node?: string;
    tokenId?: string;
    tokenSecret?: string;
    pinnedCertSha256?: string;
  }) => request<{ ok: boolean; templatesDetected: number; templates: TemplateInfo[] }>("POST", "/api/setup/validate-proxmox", input),
  setupTemplates: (node?: string) =>
    request<{ templates: TemplateInfo[] }>("GET", `/api/setup/templates${node ? `?node=${encodeURIComponent(node)}` : ""}`),
  saveSetupNetwork: (profile: unknown) => request<{ ok: true }>("POST", "/api/setup/network-profile", profile),
  completeSetup: () => request<{ ok: true }>("POST", "/api/setup/complete"),

  // --- app ---
  getMode: () => request<{ mode: "mock" | "real"; realModeAvailable: boolean }>("GET", "/api/mode"),
  listTemplates: () => request<TemplateInfo[]>("GET", "/api/templates"),
  listVms: () => request<VmInfo[]>("GET", "/api/vms"),
  listRecipes: () => request<{ recipe: Recipe; checksum: string }[]>("GET", "/api/recipes"),

  listDeployments: () => request<Deployment[]>("GET", "/api/deployments"),
  createDeployment: (plan: unknown) => request<Deployment>("POST", "/api/deployments", plan),
  getDeployment: (id: string) => request<Deployment>("GET", `/api/deployments/${id}`),
  previewPlan: (id: string) => request<PreviewPlanResult>("GET", `/api/deployments/${id}/plan`),
  runDeployment: (id: string) => request<Deployment>("POST", `/api/deployments/${id}/run`),
  retryDeployment: (id: string) => request<Deployment>("POST", `/api/deployments/${id}/retry`),
  listTransitions: (id: string) => request<DeploymentTransition[]>("GET", `/api/deployments/${id}/transitions`),
  listLogs: (id: string) => request<DeploymentLogLine[]>("GET", `/api/deployments/${id}/logs`),
  listOperations: (id: string) => request<JournalEntry[]>("GET", `/api/deployments/${id}/operations`),
  listMappings: (id: string) =>
    request<(HopMapping & { applied: boolean; verified: boolean })[]>("GET", `/api/deployments/${id}/mappings`),
  exposeDeployment: (id: string) => request<Deployment>("POST", `/api/deployments/${id}/expose`),
  deleteDeployment: (id: string) => request<{ deleted: boolean; detail: string }>("POST", `/api/deployments/${id}/delete`),

  listNetworkProfiles: () => request<NetworkProfile[]>("GET", "/api/network-profiles"),
  saveNetworkProfile: (p: unknown) => request<{ ok: true }>("POST", "/api/network-profiles", p),
  getRouter: (id: string) => request<RouterProfile | null>("GET", `/api/routers/${id}`),
  saveRouter: (p: RouterProfile) => request<{ ok: true }>("POST", "/api/routers", p),
  setRouterCredentials: (id: string, username: string, password: string) =>
    request<{ ok: true }>("POST", `/api/routers/${id}/credentials`, { username, password }),
  getChain: (id: string) => request<RouterChain | null>("GET", `/api/chains/${id}`),
  saveChain: (c: RouterChain) => request<{ ok: true }>("POST", "/api/chains", c),

  vaultStatus: () => request<{ unlocked: boolean; recordCount: number; formatVersion: number }>("GET", "/api/vault/status"),
  listAudit: () => request<AuditEntry[]>("GET", "/api/audit"),

  entitlements: () => request<Entitlements>("GET", "/api/license/entitlements"),
  deviceCode: () => request<{ code: string }>("GET", "/api/license/device-code"),
  installLicense: (license: string) => request<Entitlements>("POST", "/api/license/install", { license }),
};

// Subscribe to live deployment events over SSE. Returns an unsubscribe fn.
export function subscribeEvents(onEvent: (e: FroloUiEvent) => void): () => void {
  const es = new EventSource("/api/events", { withCredentials: true });
  es.addEventListener("frolo", (ev) => {
    try {
      onEvent(JSON.parse((ev as MessageEvent).data));
    } catch {
      /* ignore malformed */
    }
  });
  return () => es.close();
}
