// Auth + setup persistence (req: first-admin, sessions, session revocation,
// setup state). Backed by its own SQLite tables in the same database file as the
// FroloStore. Password hashes are scrypt (see password.ts). Session tokens are
// stored only as SHA-256 hashes so a DB read never yields a usable cookie value.

import Database from "better-sqlite3";
import { randomBytes, createHash, randomUUID } from "node:crypto";

const MIGRATION = `
CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS setup_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  completed INTEGER NOT NULL DEFAULT 0,
  progress_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempt (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_account ON session(account_id);
`;

export interface Account {
  id: string;
  username: string;
  role: string;
  createdAt: string;
}

export interface SetupState {
  completed: boolean;
  // Non-secret progress the OOBE can resume from (never contains passwords,
  // tokens, or the recovery code).
  progress: Record<string, unknown>;
  updatedAt: string;
}

export class AuthStore {
  // Prepared-statement cache (see FroloStore for the rationale: reusing
  // statements avoids GC'ing transient Statement objects, which can trip
  // better-sqlite3's native finalizer on some Node versions).
  private readonly stmtCache = new Map<string, Database.Statement>();

  constructor(private readonly db: Database.Database) {
    this.db.exec(MIGRATION);
  }

  private stmt(sql: string): Database.Statement {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  hasAnyAccount(): boolean {
    const row = this.stmt("SELECT COUNT(*) AS n FROM account").get() as { n: number };
    return row.n > 0;
  }

  createAccount(username: string, passwordHash: string, role = "admin"): Account {
    const acct: Account = {
      id: randomUUID(),
      username,
      role,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO account (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(acct.id, username, passwordHash, role, acct.createdAt);
    return acct;
  }

  getAccountByUsername(username: string): (Account & { passwordHash: string }) | null {
    const r = this.stmt("SELECT * FROM account WHERE username = ?").get(username) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      username: r.username as string,
      role: r.role as string,
      createdAt: r.created_at as string,
      passwordHash: r.password_hash as string,
    };
  }

  getAccountById(id: string): Account | null {
    const r = this.stmt("SELECT id, username, role, created_at FROM account WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      username: r.username as string,
      role: r.role as string,
      createdAt: r.created_at as string,
    };
  }

  // --- sessions ---
  // Returns the raw token (given to the client as a cookie); only its hash is
  // stored. `ttlMs` sets the expiry.
  createSession(accountId: string, ttlMs: number): string {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO session (token_hash, account_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        hashToken(token),
        accountId,
        new Date(now).toISOString(),
        new Date(now + ttlMs).toISOString(),
        new Date(now).toISOString(),
      );
    return token;
  }

  // Resolve a session token to its account, if valid + unexpired. Touches
  // last_seen_at. Returns null for missing/expired/revoked sessions.
  resolveSession(token: string): Account | null {
    const r = this.stmt("SELECT * FROM session WHERE token_hash = ?").get(hashToken(token)) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    if (Date.parse(r.expires_at as string) < Date.now()) {
      this.revokeSessionByHash(r.token_hash as string);
      return null;
    }
    this.stmt("UPDATE session SET last_seen_at = ? WHERE token_hash = ?").run(
      new Date().toISOString(),
      r.token_hash as string,
    );
    return this.getAccountById(r.account_id as string);
  }

  revokeSession(token: string): void {
    this.revokeSessionByHash(hashToken(token));
  }
  private revokeSessionByHash(tokenHash: string): void {
    this.stmt("DELETE FROM session WHERE token_hash = ?").run(tokenHash);
  }
  // Revoke all sessions for an account (e.g. password change / "log out
  // everywhere").
  revokeAllForAccount(accountId: string): void {
    this.stmt("DELETE FROM session WHERE account_id = ?").run(accountId);
  }

  // --- setup state ---
  getSetupState(): SetupState {
    const r = this.stmt("SELECT * FROM setup_state WHERE id = 1").get() as
      | Record<string, unknown>
      | undefined;
    if (!r) return { completed: false, progress: {}, updatedAt: new Date(0).toISOString() };
    return {
      completed: Boolean(r.completed),
      progress: JSON.parse((r.progress_json as string) || "{}"),
      updatedAt: r.updated_at as string,
    };
  }
  saveSetupProgress(progress: Record<string, unknown>): void {
    // Persist only NON-SECRET progress; callers strip secrets before this.
    this.db
      .prepare(
        `INSERT INTO setup_state (id, completed, progress_json, updated_at)
         VALUES (1, COALESCE((SELECT completed FROM setup_state WHERE id = 1), 0), ?, ?)
         ON CONFLICT(id) DO UPDATE SET progress_json = excluded.progress_json, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(progress), new Date().toISOString());
  }
  markSetupComplete(): void {
    this.db
      .prepare(
        `INSERT INTO setup_state (id, completed, progress_json, updated_at)
         VALUES (1, 1, COALESCE((SELECT progress_json FROM setup_state WHERE id = 1), '{}'), ?)
         ON CONFLICT(id) DO UPDATE SET completed = 1, updated_at = excluded.updated_at`,
      )
      .run(new Date().toISOString());
  }
  // Used by the setup-reset command (local terminal only). Preserves deployed
  // infrastructure records; only clears auth + setup so OOBE runs again.
  resetSetup(): void {
    this.db.exec("DELETE FROM session; DELETE FROM account; DELETE FROM login_attempt;");
    this.stmt("UPDATE setup_state SET completed = 0, progress_json = '{}', updated_at = ? WHERE id = 1").run(
      new Date().toISOString(),
    );
  }

  // --- login rate limiting ---
  // Fixed-window counter per IP. Returns true if the attempt is allowed.
  registerLoginAttempt(ip: string, max: number, windowMs: number): boolean {
    const now = Date.now();
    const r = this.stmt("SELECT * FROM login_attempt WHERE ip = ?").get(ip) as
      | Record<string, unknown>
      | undefined;
    if (!r || now - Date.parse(r.window_start as string) > windowMs) {
      this.db
        .prepare(
          `INSERT INTO login_attempt (ip, count, window_start) VALUES (?, 1, ?)
           ON CONFLICT(ip) DO UPDATE SET count = 1, window_start = excluded.window_start`,
        )
        .run(ip, new Date(now).toISOString());
      return true;
    }
    const count = (r.count as number) + 1;
    this.stmt("UPDATE login_attempt SET count = ? WHERE ip = ?").run(count, ip);
    return count <= max;
  }
  clearLoginAttempts(ip: string): void {
    this.stmt("DELETE FROM login_attempt WHERE ip = ?").run(ip);
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
