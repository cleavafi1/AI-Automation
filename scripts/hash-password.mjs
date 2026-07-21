// Generate the admin password credential for ADMIN_PASSWORD_HASH.
// Usage:  node scripts/hash-password.mjs "your-password"
//
// Output is a bcrypt hash, base64-encoded. We base64 it because a raw bcrypt
// hash contains "$" characters, and Next.js runs dotenv-expand over .env files
// which would mangle those (silently breaking login). base64 has no "$", so it
// survives intact; lib/auth.ts decodes it before comparing.

import bcrypt from "bcryptjs";

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hash-password.mjs "your-password"');
  process.exit(1);
}

const hash = await bcrypt.hash(password, 12);
const encoded = Buffer.from(hash, "utf8").toString("base64");
console.error("Copy this into ADMIN_PASSWORD_HASH in .env.local:");
console.log(encoded);
