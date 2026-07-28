# Voxa

Landing page plus a small auth server: registration, login, sessions, and a
SQLite database of registered users.

## Running it

```bash
npm install
npm start
```

Then open **http://localhost:4000**. The server hosts the landing page and the
API together, so the login page talks to `/api/...` on the same origin — there
is no CORS setup and no second process to start.

| URL             | What it is                                        |
| --------------- | ------------------------------------------------- |
| `/`             | The landing page                                  |
| `/login.html`   | Sign in / create account (one page, two modes)    |
| `/account.html` | Signed-in only; redirects to `/login.html` if not |

Port 4000 is the default because 3000 is usually taken by some other dev
server. Override it with `PORT=5000 npm start`.

## The database

SQLite, written to `data/users.db` on first run. The directory is gitignored —
user data never enters version control.

```
users     id, email (unique, lowercased), name, password_hash,
          created_at, last_login_at
sessions  token_hash, user_id, created_at, expires_at
```

To see who has registered:

```bash
npm run users
```

That reads the database directly. There is deliberately **no** HTTP endpoint
that returns the user list — nothing on the web side should be able to hand out
every account.

## API

| Method | Path            | Notes                                        |
| ------ | --------------- | -------------------------------------------- |
| `POST` | `/api/register` | `{name, email, password}` → 201, sets cookie |
| `POST` | `/api/login`    | `{email, password}` → 200, sets cookie       |
| `POST` | `/api/logout`   | 204, deletes the session row                 |
| `GET`  | `/api/me`       | Current user, or 401                         |

## How the auth works

- **Passwords** are hashed with scrypt (N=16384, r=8, p=1) and a random 16-byte
  salt per user, compared in constant time. Plaintext is never stored or logged.
- **Sessions** are random 256-bit tokens. Only their SHA-256 is written to the
  database, so a leaked database dump does not hand over live sessions. Tokens
  live in an `httpOnly`, `sameSite=lax` cookie for 7 days — JavaScript cannot
  read them, which keeps XSS from lifting a session, and `sameSite` blocks the
  cross-site POSTs that CSRF depends on. Signing out deletes the row, so the
  token is dead immediately rather than merely expiring.
- **Login failures** return one message and take the same amount of time
  whether or not the email exists, so neither the response nor its timing
  reveals which addresses are registered.
- **Rate limiting** allows 20 register/login attempts per IP per 15 minutes.
  The counters are in memory; they reset when the server restarts and would
  need to move into the database if this ever ran on more than one instance.
- **Static files** are served from the repo root through an extension
  allowlist, so `server.js`, `lib/`, `data/users.db`, and `node_modules/` are
  not reachable over HTTP.

Set `NODE_ENV=production` when deploying — it turns on the `secure` cookie flag
(HTTPS only) and trusts one proxy hop so rate limiting sees real client IPs.

## Deploying

The auth server needs a host that runs a persistent Node process — Render, Fly,
or Railway. Netlify only serves static files, so the current `netlify.toml`
deploy will publish the landing page but **not** a working `/api`, and
`login.html` will fail there.

Two things to sort out before pointing Netlify at this repo again:

1. `publish = "."` uploads the whole repo root, which would make `server.js`
   and `lib/*.js` downloadable from the Netlify site.
2. The login page needs to reach the API's real origin instead of a relative
   path.

Moving the static files into a `public/` directory and publishing that fixes
the first; the second needs the API's deployed URL.
