import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.join(root, "data");
const dbPath = process.env.DATABASE_PATH || path.join(dataDir, "users.db");

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);

// WAL keeps reads from blocking writes; foreign keys are off by default in SQLite.
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE,
    name          TEXT    NOT NULL,
    password_hash TEXT    NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
`);

const statements = {
  insertUser: db.prepare(
    `INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)`
  ),
  userByEmail: db.prepare(`SELECT * FROM users WHERE email = ?`),
  userById: db.prepare(`SELECT * FROM users WHERE id = ?`),
  touchLogin: db.prepare(
    `UPDATE users SET last_login_at = datetime('now') WHERE id = ?`
  ),
  insertSession: db.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`
  ),
  sessionWithUser: db.prepare(`
    SELECT s.token_hash, s.expires_at, s.created_at AS session_created_at,
           u.id, u.email, u.name, u.created_at, u.last_login_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > datetime('now')
  `),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE token_hash = ?`),
  purgeExpired: db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`),
  allUsers: db.prepare(`
    SELECT id, email, name, created_at, last_login_at FROM users ORDER BY id
  `),
};

/** Emails are stored normalized so uniqueness is case-insensitive. */
export const normalizeEmail = (email) => String(email).trim().toLowerCase();

export function createUser({ email, name, passwordHash }) {
  const info = statements.insertUser.run(normalizeEmail(email), name, passwordHash);
  return statements.userById.get(info.lastInsertRowid);
}

export const findUserByEmail = (email) => statements.userByEmail.get(normalizeEmail(email));
export const recordLogin = (userId) => statements.touchLogin.run(userId);
export const createSession = (tokenHash, userId, expiresAt) =>
  statements.insertSession.run(tokenHash, userId, expiresAt);
export const findSession = (tokenHash) => statements.sessionWithUser.get(tokenHash);
export const deleteSession = (tokenHash) => statements.deleteSession.run(tokenHash);
export const purgeExpiredSessions = () => statements.purgeExpired.run();
export const listUsers = () => statements.allUsers.all();

export { dbPath };
