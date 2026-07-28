/**
 * Prints every registered user. Run with `npm run users`.
 *
 * This is a CLI tool rather than an HTTP endpoint on purpose — the full user
 * list is not something the web app should ever be able to hand out.
 */
import { listUsers, dbPath } from "../lib/db.js";

const users = listUsers();

console.log(`\n${dbPath}`);
console.log(`${users.length} registered user${users.length === 1 ? "" : "s"}\n`);

if (users.length === 0) {
  console.log("  (none yet — register at http://localhost:3000/login.html)\n");
  process.exit(0);
}

console.table(
  users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    registered: u.created_at,
    "last login": u.last_login_at ?? "—",
  }))
);
console.log("Password hashes are never printed. Query the DB directly to see them.\n");
