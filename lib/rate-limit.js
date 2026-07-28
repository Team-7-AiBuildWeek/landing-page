/**
 * Small fixed-window rate limiter, keyed by client IP.
 *
 * In-memory on purpose: this is a single-process server, and the goal is to
 * blunt credential stuffing, not to survive a restart. If this ever runs on
 * more than one instance, move the counters into the database or Redis.
 */
export function rateLimit({ windowMs, max, message }) {
  const hits = new Map();

  // Drop stale windows so the map can't grow without bound.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs);
  sweep.unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip ?? "unknown";
    let entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    entry.count += 1;

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({ error: message, retryAfter });
    }

    next();
  };
}
