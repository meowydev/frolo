// SQLite store (req §12, §19). Typed, non-secret persistence with append-only
// transitions/logs/audit and an operation journal for crash recovery.

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  AuditEntry,
  Deployment,
  DeploymentLogLine,
  DeploymentPlan,
  DeploymentState,
  DeploymentTransition,
  HopMapping,
  JournalAction,
  JournalEntry,
  JournalStatus,
  NetworkProfile,
  Recipe,
  RouterChain,
  RouterProfile,
  Workflow,
} from "@frolo/contracts";
import { MIGRATIONS } from "./schema.js";

export class FroloStore {
  private readonly db: Database.Database;
  // Cache of prepared statements keyed by SQL. Reusing statement objects avoids
  // short-lived Statement instances on every call, which can trip
  // better-sqlite3's native finalizer under GC on some Node versions.
  private readonly stmtCache = new Map<string, Database.Statement>();

  constructor(pathOrMemory: string) {
    this.db = new Database(pathOrMemory);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  // Prepare-with-cache. New queries should use this instead of this.db.prepare.
  private stmt(sql: string): Database.Statement {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  // Expose the underlying connection so co-located stores (e.g. the server's
  // AuthStore) can share ONE better-sqlite3 handle. Opening a second connection
  // to the same file triggers a native finalizer assertion under GC.
  rawDb(): Database.Database {
    return this.db;
  }

  private migrate(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, at TEXT NOT NULL)",
    );
    const applied = new Set(
      this.db
        .prepare("SELECT id FROM _migrations")
        .all()
        .map((r) => (r as { id: number }).id),
    );
    const insert = this.db.prepare(
      "INSERT INTO _migrations (id, at) VALUES (?, ?)",
    );
    const tx = this.db.transaction(() => {
      for (const m of MIGRATIONS) {
        if (!applied.has(m.id)) {
          this.db.exec(m.sql);
          insert.run(m.id, new Date().toISOString());
        }
      }
    });
    tx();
  }

  close(): void {
    this.db.close();
  }

  // --- Network profiles ---
  saveNetworkProfile(p: NetworkProfile): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO network_profile
         (id, name, mode, subnet_cidr, gateway, address, vmid_rule_json, created_at)
         VALUES (@id, @name, @mode, @subnetCidr, @gateway, @address, @vmidRuleJson, @createdAt)`,
      )
      .run({
        id: p.id,
        name: p.name,
        mode: p.mode,
        subnetCidr: p.subnetCidr ?? null,
        gateway: p.gateway ?? null,
        address: p.address ?? null,
        vmidRuleJson: p.vmidRule ? JSON.stringify(p.vmidRule) : null,
        createdAt: new Date().toISOString(),
      });
  }
  getNetworkProfile(id: string): NetworkProfile | null {
    const r = this.db
      .prepare("SELECT * FROM network_profile WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      name: r.name as string,
      mode: r.mode as NetworkProfile["mode"],
      subnetCidr: (r.subnet_cidr as string) ?? undefined,
      gateway: (r.gateway as string) ?? undefined,
      address: (r.address as string) ?? undefined,
      vmidRule: r.vmid_rule_json
        ? JSON.parse(r.vmid_rule_json as string)
        : undefined,
    };
  }
  listNetworkProfiles(): NetworkProfile[] {
    return (
      this.db.prepare("SELECT id FROM network_profile").all() as {
        id: string;
      }[]
    )
      .map((x) => this.getNetworkProfile(x.id)!)
      .filter(Boolean);
  }

  // --- Router profiles ---
  saveRouterProfile(p: RouterProfile): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO router_profile
         (id, name, base_url, scheme, pinned_cert_fingerprint, kind, created_at)
         VALUES (@id, @name, @baseUrl, @scheme, @fp, @kind, @createdAt)`,
      )
      .run({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        scheme: p.scheme,
        fp: p.pinnedCertFingerprint ?? null,
        kind: p.kind,
        createdAt: new Date().toISOString(),
      });
  }
  getRouterProfile(id: string): RouterProfile | null {
    const r = this.db
      .prepare("SELECT * FROM router_profile WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      name: r.name as string,
      baseUrl: r.base_url as string,
      scheme: r.scheme as RouterProfile["scheme"],
      pinnedCertFingerprint: (r.pinned_cert_fingerprint as string) ?? undefined,
      kind: r.kind as RouterProfile["kind"],
    };
  }

  // --- Workflows ---
  saveWorkflow(w: Workflow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO workflow
         (id, router_profile_id, kind, version, steps_json, created_at)
         VALUES (@id, @rp, @kind, @version, @steps, @createdAt)`,
      )
      .run({
        id: w.id,
        rp: w.routerProfileId,
        kind: w.kind,
        version: w.version,
        steps: JSON.stringify(w.steps),
        createdAt: new Date().toISOString(),
      });
  }
  getWorkflow(routerProfileId: string, kind: Workflow["kind"]): Workflow | null {
    const r = this.db
      .prepare(
        "SELECT * FROM workflow WHERE router_profile_id = ? AND kind = ? ORDER BY version DESC LIMIT 1",
      )
      .get(routerProfileId, kind) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      routerProfileId: r.router_profile_id as string,
      kind: r.kind as Workflow["kind"],
      version: r.version as number,
      steps: JSON.parse(r.steps_json as string),
    };
  }

  // --- Router chains ---
  saveRouterChain(c: RouterChain): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO router_chain (id, name, hops_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(c.id, c.name, JSON.stringify(c.hops), new Date().toISOString());
  }
  getRouterChain(id: string): RouterChain | null {
    const r = this.db
      .prepare("SELECT * FROM router_chain WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      name: r.name as string,
      hops: JSON.parse(r.hops_json as string),
    };
  }

  // --- Recipes ---
  saveRecipe(r: Recipe, checksum: string): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO recipe (id, name, version, source, checksum, json) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(r.id, r.name, r.version, r.source, checksum, JSON.stringify(r));
  }
  getRecipe(id: string): { recipe: Recipe; checksum: string } | null {
    const r = this.db.prepare("SELECT * FROM recipe WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      recipe: JSON.parse(r.json as string),
      checksum: r.checksum as string,
    };
  }
  listRecipes(): { recipe: Recipe; checksum: string }[] {
    return (this.db.prepare("SELECT json, checksum FROM recipe").all() as {
      json: string;
      checksum: string;
    }[]).map((x) => ({ recipe: JSON.parse(x.json), checksum: x.checksum }));
  }

  // --- Deployments ---
  createDeployment(plan: DeploymentPlan): Deployment {
    const now = new Date().toISOString();
    const dep: Deployment = {
      id: randomUUID(),
      plan,
      state: "Queued",
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO deployment (id, name, plan_json, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(dep.id, plan.name, JSON.stringify(plan), dep.state, now, now);
    return dep;
  }

  getDeployment(id: string): Deployment | null {
    const r = this.db.prepare("SELECT * FROM deployment WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      plan: JSON.parse(r.plan_json as string),
      state: r.state as DeploymentState,
      targetVmid: (r.target_vmid as number) ?? undefined,
      localAddress: (r.local_address as string) ?? undefined,
      publicAddressSim: (r.public_address_sim as string) ?? undefined,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  }

  listDeployments(): Deployment[] {
    return (
      this.db
        .prepare("SELECT id FROM deployment ORDER BY created_at DESC")
        .all() as { id: string }[]
    ).map((x) => this.getDeployment(x.id)!);
  }

  updateDeployment(
    id: string,
    patch: Partial<
      Pick<
        Deployment,
        "state" | "targetVmid" | "localAddress" | "publicAddressSim"
      >
    >,
  ): void {
    const cur = this.getDeployment(id);
    if (!cur) throw new Error(`no deployment ${id}`);
    const next = { ...cur, ...patch };
    this.db
      .prepare(
        `UPDATE deployment SET state=?, target_vmid=?, local_address=?, public_address_sim=?, updated_at=?
         WHERE id=?`,
      )
      .run(
        next.state,
        next.targetVmid ?? null,
        next.localAddress ?? null,
        next.publicAddressSim ?? null,
        new Date().toISOString(),
        id,
      );
  }

  // --- Transitions (append-only) ---
  appendTransition(
    deploymentId: string,
    from: DeploymentState | null,
    to: DeploymentState,
    reasonSanitized: string,
  ): DeploymentTransition {
    const t: DeploymentTransition = {
      id: randomUUID(),
      deploymentId,
      from,
      to,
      reasonSanitized,
      at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO deployment_transition (id, deployment_id, from_state, to_state, reason_sanitized, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(t.id, deploymentId, from, to, reasonSanitized, t.at);
    return t;
  }
  listTransitions(deploymentId: string): DeploymentTransition[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM deployment_transition WHERE deployment_id = ? ORDER BY at ASC, rowid ASC",
        )
        .all(deploymentId) as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as string,
      deploymentId: r.deployment_id as string,
      from: (r.from_state as DeploymentState) ?? null,
      to: r.to_state as DeploymentState,
      reasonSanitized: r.reason_sanitized as string,
      at: r.at as string,
    }));
  }

  // --- Logs (append-only, sanitized by caller) ---
  appendLog(
    deploymentId: string,
    level: DeploymentLogLine["level"],
    messageSanitized: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO deployment_log (id, deployment_id, level, message_sanitized, at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        randomUUID(),
        deploymentId,
        level,
        messageSanitized,
        new Date().toISOString(),
      );
  }
  listLogs(deploymentId: string): DeploymentLogLine[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM deployment_log WHERE deployment_id = ? ORDER BY at ASC, rowid ASC",
        )
        .all(deploymentId) as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as string,
      deploymentId: r.deployment_id as string,
      level: r.level as DeploymentLogLine["level"],
      messageSanitized: r.message_sanitized as string,
      at: r.at as string,
    }));
  }

  // --- Operation journal (req §19) ---
  beginOperation(input: {
    deploymentId: string;
    idempotencyKey: string;
    target: string;
    action: JournalAction;
  }): JournalEntry {
    // Idempotent: if an entry with this key exists, return it (no duplicate).
    const existing = this.getOperationByKey(input.idempotencyKey);
    if (existing) return existing;
    const entry: JournalEntry = {
      id: randomUUID(),
      deploymentId: input.deploymentId,
      idempotencyKey: input.idempotencyKey,
      target: input.target,
      action: input.action,
      status: "pending",
      startedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO operation (id, deployment_id, idempotency_key, target, action, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.deploymentId,
        entry.idempotencyKey,
        entry.target,
        entry.action,
        entry.status,
        entry.startedAt,
      );
    return entry;
  }

  setOperationUpid(id: string, upid: string): void {
    this.db
      .prepare("UPDATE operation SET upid = ?, status = 'in_flight' WHERE id = ?")
      .run(upid, id);
  }

  setOperationStatus(
    id: string,
    status: JournalStatus,
    observedResultSanitized?: string,
  ): void {
    this.db
      .prepare(
        "UPDATE operation SET status = ?, observed_result_sanitized = ?, reconciled_at = ? WHERE id = ?",
      )
      .run(
        status,
        observedResultSanitized ?? null,
        new Date().toISOString(),
        id,
      );
  }

  getOperationByKey(key: string): JournalEntry | null {
    const r = this.db
      .prepare("SELECT * FROM operation WHERE idempotency_key = ?")
      .get(key) as Record<string, unknown> | undefined;
    return r ? rowToJournal(r) : null;
  }

  listUnresolvedOperations(): JournalEntry[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM operation WHERE status IN ('pending','in_flight')",
        )
        .all() as Record<string, unknown>[]
    ).map(rowToJournal);
  }

  listOperations(deploymentId: string): JournalEntry[] {
    return (
      this.db
        .prepare("SELECT * FROM operation WHERE deployment_id = ? ORDER BY started_at ASC, rowid ASC")
        .all(deploymentId) as Record<string, unknown>[]
    ).map(rowToJournal);
  }

  // --- Mapping records ---
  saveMapping(deploymentId: string, m: HopMapping, applied: boolean, verified: boolean): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO mapping_record
         (id, deployment_id, hop_index, router_profile_id, listen_address, listen_port,
          target_address, target_port, protocol, applied, verified, at)
         VALUES (@id, @dep, @hop, @rp, @la, @lp, @ta, @tp, @proto, @applied, @verified, @at)`,
      )
      .run({
        id: `${deploymentId}:${m.hopIndex}`,
        dep: deploymentId,
        hop: m.hopIndex,
        rp: m.routerProfileId,
        la: m.listenAddress,
        lp: m.listenPort,
        ta: m.targetAddress,
        tp: m.targetPort,
        proto: m.protocol,
        applied: applied ? 1 : 0,
        verified: verified ? 1 : 0,
        at: new Date().toISOString(),
      });
  }
  listMappings(deploymentId: string): (HopMapping & { applied: boolean; verified: boolean })[] {
    return (
      this.db
        .prepare("SELECT * FROM mapping_record WHERE deployment_id = ? ORDER BY hop_index ASC")
        .all(deploymentId) as Record<string, unknown>[]
    ).map((r) => ({
      hopIndex: r.hop_index as number,
      routerProfileId: r.router_profile_id as string,
      listenAddress: r.listen_address as string,
      listenPort: r.listen_port as number,
      targetAddress: r.target_address as string,
      targetPort: r.target_port as number,
      protocol: r.protocol as HopMapping["protocol"],
      applied: Boolean(r.applied),
      verified: Boolean(r.verified),
    }));
  }

  // --- Audit (append-only) ---
  appendAudit(
    actor: string,
    action: string,
    subject: string,
    detailSanitized: string,
  ): AuditEntry {
    const entry: AuditEntry = {
      id: randomUUID(),
      actor,
      action,
      subject,
      detailSanitized,
      at: new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO audit (id, actor, action, subject, detail_sanitized, at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(entry.id, actor, action, subject, detailSanitized, entry.at);
    return entry;
  }
  listAudit(): AuditEntry[] {
    return (
      this.db
        .prepare("SELECT * FROM audit ORDER BY at DESC, rowid DESC")
        .all() as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as string,
      actor: r.actor as string,
      action: r.action as string,
      subject: r.subject as string,
      detailSanitized: r.detail_sanitized as string,
      at: r.at as string,
    }));
  }

  // --- Proxmox connections (real mode; non-secret metadata only) ---
  saveConnection(c: import("@frolo/contracts").ProxmoxConnection): void {
    this.stmt(
      `INSERT OR REPLACE INTO connection (id, name, host, node, token_id, cert_fingerprint, pinned, created_at)
       VALUES (@id, @name, @host, @node, @tokenId, @certFingerprint, @pinned, @createdAt)`,
    ).run({
      id: c.id,
      name: c.name,
      host: c.host,
      node: c.node,
      tokenId: c.tokenId,
      certFingerprint: c.certFingerprint ?? null,
      pinned: c.pinned ? 1 : 0,
      createdAt: c.createdAt,
    });
  }
  getConnection(id: string): import("@frolo/contracts").ProxmoxConnection | null {
    const r = this.stmt("SELECT * FROM connection WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      name: r.name as string,
      host: r.host as string,
      node: r.node as string,
      tokenId: r.token_id as string,
      certFingerprint: (r.cert_fingerprint as string) ?? undefined,
      pinned: Boolean(r.pinned),
      createdAt: r.created_at as string,
    };
  }
  listConnections(): import("@frolo/contracts").ProxmoxConnection[] {
    return (this.stmt("SELECT id FROM connection ORDER BY created_at ASC").all() as { id: string }[])
      .map((x) => this.getConnection(x.id)!)
      .filter(Boolean);
  }
  deleteConnection(id: string): void {
    this.stmt("DELETE FROM connection WHERE id = ?").run(id);
  }

  // --- Runtime config (active mode + selected connection) ---
  getRuntimeConfig(): { mode: "mock" | "real"; activeConnectionId: string | null } {
    const r = this.stmt("SELECT * FROM runtime_config WHERE id = 1").get() as Record<string, unknown> | undefined;
    if (!r) return { mode: "mock", activeConnectionId: null };
    return {
      mode: (r.mode as "mock" | "real") ?? "mock",
      activeConnectionId: (r.active_connection_id as string) ?? null,
    };
  }
  setRuntimeConfig(cfg: { mode: "mock" | "real"; activeConnectionId?: string | null }): void {
    this.stmt(
      `INSERT INTO runtime_config (id, mode, active_connection_id, updated_at)
       VALUES (1, @mode, @conn, @at)
       ON CONFLICT(id) DO UPDATE SET mode = excluded.mode, active_connection_id = excluded.active_connection_id, updated_at = excluded.updated_at`,
    ).run({ mode: cfg.mode, conn: cfg.activeConnectionId ?? null, at: new Date().toISOString() });
  }

  // Introspection for the no-secret-columns test (req §12.2).
  listAllColumns(): string[] {
    const tables = (
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[]
    ).map((t) => t.name);
    const cols: string[] = [];
    for (const t of tables) {
      const info = this.db.prepare(`PRAGMA table_info(${t})`).all() as {
        name: string;
      }[];
      for (const c of info) cols.push(`${t}.${c.name}`);
    }
    return cols;
  }
}

function rowToJournal(r: Record<string, unknown>): JournalEntry {
  return {
    id: r.id as string,
    deploymentId: r.deployment_id as string,
    idempotencyKey: r.idempotency_key as string,
    target: r.target as string,
    action: r.action as JournalAction,
    upid: (r.upid as string) ?? undefined,
    status: r.status as JournalStatus,
    startedAt: r.started_at as string,
    observedResultSanitized: (r.observed_result_sanitized as string) ?? undefined,
    reconciledAt: (r.reconciled_at as string) ?? undefined,
  };
}
