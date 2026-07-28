import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import {
  createUser,
  findUserByEmail,
  recordLogin,
  createSession,
  findSession,
  deleteSession,
  purgeExpiredSessions,
  dbPath,
} from "./lib/db.js";
import {
  hashPassword,
  verifyPassword,
  burnTime,
  newSessionToken,
  hashToken,
  sessionExpiry,
  SESSION_TTL_DAYS,
} from "./lib/auth.js";
import { rateLimit } from "./lib/rate-limit.js";

const root = path.dirname(fileURLToPath(import.meta.url));
// 4000 rather than the usual 3000, which tends to be occupied by a framework
// dev server. Override with PORT=… if it clashes.
const PORT = Number(process.env.PORT) || 4000;
const PRODUCTION = process.env.NODE_ENV === "production";
const COOKIE = "narro_session";

const app = express();
app.disable("x-powered-by");
// Trust the first proxy hop so req.ip is the real client when deployed behind
// one. Left off in dev, where a spoofed X-Forwarded-For would defeat rate limits.
if (PRODUCTION) app.set("trust proxy", 1);

app.use(express.json({ limit: "16kb" }));

/* ============ STATIC FILES ============ */

// The landing page lives at the repo root alongside server code, node_modules
// and data/users.db. Rather than denylisting those, only serve extensions that
// are front-end assets by definition — server code can never match.
const SERVABLE = new Set([
  ".html", ".css", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif",
  ".ico", ".woff", ".woff2", ".ttf", ".map", ".txt", ".webmanifest",
]);

// Browser JavaScript is the one exception, and only from /assets/. Allowing
// .js everywhere would expose server.js and lib/*.js as plain downloads.
//
// The path MUST be decoded and normalized before it is tested. Checking the
// raw string lets "/assets/../server.js" pass — it starts with /assets/ and
// ends with .js — and express.static then resolves it to the real server.js.
const isBrowserScript = (rawPath) => {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return false; // malformed percent-encoding
  }
  const resolved = path.posix.normalize(decoded);
  return resolved.startsWith("/assets/") && resolved.endsWith(".js");
};

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  const ext = path.extname(req.path).toLowerCase();
  if (ext === "" || SERVABLE.has(ext) || isBrowserScript(req.path)) return next();
  res.status(404).type("text/plain").send("Not found");
});

app.use(express.static(root, { dotfiles: "deny", extensions: ["html"] }));

/* ============ HELPERS ============ */

/** Minimal cookie-header parse — the session cookie is the only one we read. */
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

const cookieOptions = {
  httpOnly: true, // not readable from JavaScript, so XSS can't lift the token
  sameSite: "lax", // blocks the cross-site POSTs that CSRF relies on
  secure: PRODUCTION, // HTTPS-only in production; would break plain-http localhost
  path: "/",
};

function startSession(res, userId) {
  const { token, tokenHash } = newSessionToken();
  createSession(tokenHash, userId, sessionExpiry());
  res.cookie(COOKIE, token, {
    ...cookieOptions,
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

const publicUser = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  createdAt: row.created_at,
  lastLoginAt: row.last_login_at,
});

/** Resolves the session cookie to a user, or null. */
function currentUser(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  return findSession(hashToken(token)) ?? null;
}

function requireAuth(req, res, next) {
  const session = currentUser(req);
  if (!session) return res.status(401).json({ error: "Not signed in" });
  req.user = session;
  next();
}

/* ============ VALIDATION ============ */

// Deliberately permissive: the only authoritative test of an address is
// sending mail to it, and over-strict patterns reject valid addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const MIN_PASSWORD = 8;

function validateCredentials({ email, password, name }, { isRegister }) {
  const errors = {};

  if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
    errors.email = "Enter a valid email address.";
  } else if (email.trim().length > 254) {
    errors.email = "That email address is too long.";
  }

  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    errors.password = `Password must be at least ${MIN_PASSWORD} characters.`;
  } else if (password.length > 200) {
    errors.password = "Password must be 200 characters or fewer.";
  }

  if (isRegister) {
    if (typeof name !== "string" || name.trim().length === 0) {
      errors.name = "Enter your name.";
    } else if (name.trim().length > 80) {
      errors.name = "Name must be 80 characters or fewer.";
    }
  }

  return errors;
}

/* ============ AUTH ROUTES ============ */

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Too many attempts. Try again in a few minutes.",
});

app.post("/api/register", writeLimiter, (req, res) => {
  const { name, email, password } = req.body ?? {};
  const errors = validateCredentials({ name, email, password }, { isRegister: true });
  if (Object.keys(errors).length) return res.status(400).json({ errors });

  if (findUserByEmail(email)) {
    return res.status(409).json({
      errors: { email: "That email is already registered. Try signing in." },
    });
  }

  let user;
  try {
    user = createUser({
      email,
      name: name.trim(),
      passwordHash: hashPassword(password),
    });
  } catch (err) {
    // Two simultaneous registrations for the same email: the UNIQUE index is
    // the real guard, the lookup above is just for a nicer message.
    if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({
        errors: { email: "That email is already registered. Try signing in." },
      });
    }
    throw err;
  }

  recordLogin(user.id);
  startSession(res, user.id);
  res.status(201).json({ user: publicUser(findUserByEmail(email)) });
});

app.post("/api/login", writeLimiter, (req, res) => {
  const { email, password } = req.body ?? {};

  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  const user = findUserByEmail(email);

  // Same message and same amount of work either way, so neither the response
  // nor its timing reveals whether the email is registered.
  if (!user) {
    burnTime();
    return res.status(401).json({ error: "Email or password is incorrect." });
  }
  if (!verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "Email or password is incorrect." });
  }

  recordLogin(user.id);
  startSession(res, user.id);
  res.json({ user: publicUser(findUserByEmail(email)) });
});

app.post("/api/logout", (req, res) => {
  const token = readCookie(req, COOKIE);
  if (token) deleteSession(hashToken(token));
  res.clearCookie(COOKIE, cookieOptions);
  res.status(204).end();
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user), sessionExpiresAt: req.user.expires_at });
});

/* ============ ERRORS ============ */

app.use("/api", (req, res) => res.status(404).json({ error: "Unknown endpoint" }));

app.use((err, req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: "Something went wrong on our end." });
});

/* ============ START ============ */

purgeExpiredSessions();
setInterval(purgeExpiredSessions, 60 * 60 * 1000).unref();

const server = app.listen(PORT, () => {
  console.log(`Narro running at http://localhost:${PORT}`);
  console.log(`Database: ${dbPath}`);
  if (!PRODUCTION) console.log(`Sign in: http://localhost:${PORT}/login.html`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Try: PORT=${PORT + 1} npm start`);
    process.exit(1);
  }
  throw err;
});
