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

/* ============ PLACE RATINGS ============ */

// Real visitor ratings need a keyed provider. The key stays here — the
// browser only ever talks to this endpoint, never to the upstream. With no
// key configured the planner falls back to its Wikipedia readership signal,
// so the feature degrades instead of breaking.
const TRIPADVISOR_KEY = process.env.TRIPADVISOR_API_KEY;
const GOOGLE_PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY;
const RATINGS_PROVIDER = TRIPADVISOR_KEY
  ? "tripadvisor"
  : GOOGLE_PLACES_KEY
    ? "google"
    : null;

// Ratings barely move day to day, and the free tiers are small (TripAdvisor
// allows ~5k calls/month), so answers are cached for a day.
const RATINGS_TTL_MS = 24 * 60 * 60 * 1000;
const ratingsCache = new Map();

function cacheGet(key) {
  const hit = ratingsCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > RATINGS_TTL_MS) {
    ratingsCache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key, value) {
  // Bounded so a long-running process can't grow this without limit.
  if (ratingsCache.size > 5000) ratingsCache.clear();
  ratingsCache.set(key, { at: Date.now(), value });
}

async function lookupTripadvisor(name, city) {
  const search = new URL("https://api.content.tripadvisor.com/api/v1/location/search");
  search.searchParams.set("key", TRIPADVISOR_KEY);
  search.searchParams.set("searchQuery", name);
  search.searchParams.set("category", "attractions");
  if (city) search.searchParams.set("address", city);

  const found = await fetch(search, { headers: { accept: "application/json" } });
  if (!found.ok) return null;
  const hit = (await found.json())?.data?.[0];
  if (!hit?.location_id) return null;

  const details = new URL(`https://api.content.tripadvisor.com/api/v1/location/${hit.location_id}/details`);
  details.searchParams.set("key", TRIPADVISOR_KEY);
  const res = await fetch(details, { headers: { accept: "application/json" } });
  if (!res.ok) return null;
  const d = await res.json();
  if (!d.rating) return null;

  return {
    rating: Number(d.rating),
    reviews: Number(d.num_reviews) || 0,
    url: d.web_url || null,
  };
}

async function lookupGooglePlaces(name, city) {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": GOOGLE_PLACES_KEY,
      "X-Goog-FieldMask": "places.rating,places.userRatingCount,places.googleMapsUri",
    },
    body: JSON.stringify({ textQuery: city ? `${name}, ${city}` : name, maxResultCount: 1 }),
  });
  if (!res.ok) return null;
  const place = (await res.json())?.places?.[0];
  if (!place?.rating) return null;

  return {
    rating: Number(place.rating),
    reviews: Number(place.userRatingCount) || 0,
    url: place.googleMapsUri || null,
  };
}

const ratingsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: "Too many rating lookups. Try again in a few minutes.",
});

app.post("/api/ratings", ratingsLimiter, async (req, res) => {
  const { city, names } = req.body ?? {};

  if (!RATINGS_PROVIDER) {
    // Not an error: the planner asks first and adapts to the answer.
    return res.json({ configured: false, provider: null, results: {} });
  }
  if (!Array.isArray(names) || !names.length) {
    return res.status(400).json({ error: "names must be a non-empty array" });
  }

  const wanted = names
    .filter((n) => typeof n === "string" && n.trim())
    .slice(0, 12) // one itinerary's worth, so a single call can't fan out
    .map((n) => n.trim().slice(0, 120));

  const lookup = RATINGS_PROVIDER === "tripadvisor" ? lookupTripadvisor : lookupGooglePlaces;
  const cityName = typeof city === "string" ? city.slice(0, 80) : "";

  const entries = await Promise.all(
    wanted.map(async (name) => {
      const key = `${RATINGS_PROVIDER}:${cityName}:${name}`.toLowerCase();
      const cached = cacheGet(key);
      if (cached !== undefined) return [name, cached];
      try {
        const value = await lookup(name, cityName);
        cacheSet(key, value);
        return [name, value];
      } catch {
        // One bad lookup shouldn't sink the whole itinerary.
        return [name, null];
      }
    })
  );

  const results = {};
  for (const [name, value] of entries) if (value) results[name] = value;

  res.json({ configured: true, provider: RATINGS_PROVIDER, results });
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
