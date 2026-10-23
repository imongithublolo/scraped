// MURKE — password hash generator.
//   node scripts/hash-password.mjs <your-new-password>
// Prints a salted SHA-256 digest to set as GATE_PASSWORD_HASH.
import { createHash } from "node:crypto";

const SALT = "murke-proxy::";
const pw = process.argv[2];

if (!pw) {
  console.error("usage: node scripts/hash-password.mjs <password>");
  process.exit(1);
}

console.log(createHash("sha256").update(SALT + pw).digest("hex"));
