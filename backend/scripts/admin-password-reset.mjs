#!/usr/bin/env node
// Admin password reset: rewrite one `admin_users.passwordHash`.
//
// WHY: changing ADMIN_PASSWORD in the environment does NOT change an existing
// admin's password. `AuthService.onModuleInit` only SEEDS the admin when no user
// with ADMIN_EMAIL exists (`if (existing) return;`), and there is no route or UI
// that changes it. So after a leak, rotating the env var leaves the old password
// working. This script writes the new hash directly, in the exact format
// `src/auth/password.util.ts` produces (`<salt hex>:<scrypt hex>`, 16-byte salt,
// 64-byte key, node:crypto scrypt defaults) and re-reads it to verify.
//
// It prints the admin's `lastLoginAt` so you can see whether anyone signed in
// since the leak. Admin sessions are 12 h JWTs signed with JWT_SECRET and are NOT
// revoked by a password change: to end every existing admin session at once,
// also rotate JWT_SECRET in Railway (customer logins use CUSTOMER_JWT_SECRET and
// are unaffected).
//
// Usage (from backend/). Keep secrets out of shell history — put them in a file
// outside the repo:
//   MONGODB_URI=…            the prod Atlas URI
//   ADMIN_EMAIL=…            the admin to reset
//   NEW_ADMIN_PASSWORD=…     at least 16 characters; never printed
//   node --env-file=/secure/admin-reset.env scripts/admin-password-reset.mjs           (diagnose)
//   node --env-file=/secure/admin-reset.env scripts/admin-password-reset.mjs --apply   (write)
// Afterwards set ADMIN_PASSWORD in Railway to the same value, so a fresh database
// would seed the same password, and delete the env file.
import mongoose from 'mongoose';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEYLEN = 64; // password.util.ts KEYLEN
const MIN_LENGTH = 16;

function hashPassword(password) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(password, salt, KEYLEN).toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex ?? '', 'hex');
  if (!saltHex || expected.length !== KEYLEN) return false;
  return timingSafeEqual(expected, scryptSync(password, Buffer.from(saltHex, 'hex'), KEYLEN));
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(2);
}

function describeUrl(raw) {
  try {
    const u = new URL(raw);
    if (!['mongodb:', 'mongodb+srv:'].includes(u.protocol)) return '(redacted: unexpected URL scheme)';
    return `${u.protocol}//${u.host}${u.pathname && u.pathname !== '/' ? u.pathname : ''}`;
  } catch {
    return '(redacted: unparseable URL)';
  }
}

async function main() {
  const args = process.argv.slice(2);
  for (const a of args) if (a !== '--apply') fail(`unknown argument '${a}' (expected --apply)`);
  const apply = args.includes('--apply');
  const uri = process.env.MONGODB_URI;
  const email = process.env.ADMIN_EMAIL?.toLowerCase().trim();
  const password = process.env.NEW_ADMIN_PASSWORD;
  if (!uri) fail('MONGODB_URI is not set');
  if (!email) fail('ADMIN_EMAIL is not set');
  if (!password) fail('NEW_ADMIN_PASSWORD is not set');
  if (password.length < MIN_LENGTH) fail(`NEW_ADMIN_PASSWORD must be at least ${MIN_LENGTH} characters`);
  if (password !== password.trim()) fail('NEW_ADMIN_PASSWORD has leading/trailing whitespace — almost certainly a copy/paste slip');

  console.log(`mode  : ${apply ? 'APPLY (writes admin_users)' : 'diagnose (read-only)'}`);
  console.log(`mongo : ${describeUrl(uri)}`);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000 });
  try {
    const users = mongoose.connection.db.collection('admin_users');
    const all = await users.find({}, { projection: { email: 1, lastLoginAt: 1, updatedAt: 1 } }).toArray();
    console.log(`admin users (${all.length}):`);
    for (const u of all) {
      console.log(`  ${u.email}  lastLoginAt=${u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : 'never'}  updatedAt=${u.updatedAt ? new Date(u.updatedAt).toISOString() : '-'}`);
    }
    const target = await users.findOne({ email }, { projection: { passwordHash: 1 } });
    if (!target) fail(`no admin user with email ${email} — nothing to reset (a boot with ADMIN_EMAIL/ADMIN_PASSWORD would seed it)`);
    if (verifyPassword(password, target.passwordHash)) {
      console.log('\nThe stored hash ALREADY matches NEW_ADMIN_PASSWORD — nothing to do.');
      return;
    }
    if (!apply) {
      console.log(`\nWould replace the password hash of ${email}. Re-run with --apply to write.`);
      return;
    }
    const res = await users.updateOne({ _id: target._id }, { $set: { passwordHash: hashPassword(password), updatedAt: new Date() } });
    if (res.matchedCount !== 1) fail('the admin user disappeared before the write — nothing changed');
    const after = await users.findOne({ _id: target._id }, { projection: { passwordHash: 1 }, readPreference: 'primary' });
    if (!verifyPassword(password, after?.passwordHash)) fail('write did not verify — check the admin_users row by hand');
    console.log(`\nPassword hash of ${email} replaced and verified. The old password no longer works.`);
    console.log('Next: set ADMIN_PASSWORD in Railway to the same value; rotate JWT_SECRET to end existing admin sessions; delete the env file.');
  } finally {
    await mongoose.disconnect().catch(() => undefined);
  }
}

main().catch((err) => {
  const pw = process.env.NEW_ADMIN_PASSWORD;
  let text = String(err?.stack ?? err);
  if (pw) text = text.split(pw).join('***');
  try {
    const p = new URL(process.env.MONGODB_URI ?? '').password;
    if (p) text = text.split(p).join('***').split(decodeURIComponent(p)).join('***');
  } catch { /* not a URL */ }
  console.error(`FAILED: ${text}`);
  process.exit(1);
});
