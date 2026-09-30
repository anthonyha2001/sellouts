// One-time: creates the Web Push keys and the scheduler's secret, and adds them to .env
// (never committed). Prints what to do with them.
//   node scripts/make-push-keys.mjs
// VAPID_PUBLIC_KEY  : goes in the app (js/core/config.js) — it is public by design.
// VAPID_PRIVATE_JWK : Supabase secret of the push-alerts function (signs the pushes). Keep private.
// PUSH_CRON_SECRET  : shared by the scheduler (Vault) and the function, so only the scheduler can run it.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync, appendFileSync } from 'node:fs';

const env = readFileSync('.env', 'utf8');
if (/^VAPID_PRIVATE_JWK=/m.test(env)) { console.log('.env already has push keys — nothing done.'); process.exit(0); }
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = privateKey.export({ format: 'jwk' });                                  // { kty, crv, x, y, d }
const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
const pub = raw.toString('base64url');
const cron = randomBytes(24).toString('base64url');
appendFileSync('.env', `\n# Web Push (scripts/make-push-keys.mjs)\nVAPID_PUBLIC_KEY=${pub}\nVAPID_PRIVATE_JWK=${JSON.stringify(jwk)}\nPUSH_CRON_SECRET=${cron}\n`);
console.log('Added VAPID_PUBLIC_KEY, VAPID_PRIVATE_JWK and PUSH_CRON_SECRET to .env');
console.log('Public key (for js/core/config.js):', pub);
