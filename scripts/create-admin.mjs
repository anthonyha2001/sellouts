// Bootstrap a login + profile (used for the FIRST admin; later users are managed from the app's Users page).
// Requires migration 001 to be applied. Safe to re-run: an existing account is reused and its profile updated.
//   node --env-file=.env scripts/create-admin.mjs --email you@example.com --password '...' --username you --name "Your Name" [--role admin]
// A plain username (no @) becomes <username>@lvajaltoun.local, as the login screen does.
import pg from 'pg';

const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : undefined; };
const username = (arg('username') || '').toLowerCase();
const email = (arg('email') || (username && `${username}@lvajaltoun.local`) || '').toLowerCase();
const password = arg('password');
const name = arg('name') || username;
const role = arg('role') || 'admin';
const { SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_DB_URL } = process.env;

if (!username || !email || !password) { console.error('Need --username, --password and (optionally) --email'); process.exit(2); }
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !SUPABASE_DB_URL) { console.error('Run with --env-file=.env'); process.exit(2); }

const auth = (path, opts = {}) => fetch(`${SUPABASE_URL}/auth/v1/admin/${path}`, {
  ...opts,
  headers: { apikey: SUPABASE_SECRET_KEY, Authorization: `Bearer ${SUPABASE_SECRET_KEY}`, 'Content-Type': 'application/json' },
});

// 1. Auth account (email pre-confirmed, so no confirmation mail is needed).
let userId;
const res = await auth('users', { method: 'POST', body: JSON.stringify({ email, password, email_confirm: true }) });
const body = await res.json();
if (res.ok) {
  userId = body.id;
  console.log(`Created login ${email}`);
} else if (/already|exists|registered/i.test(body.msg || body.message || body.error_code || '')) {
  const list = await (await auth('users?per_page=1000')).json();
  userId = (list.users || []).find(u => u.email === email)?.id;
  if (!userId) { console.error('Account exists but could not be found:', body); process.exit(1); }
  const up = await auth(`users/${userId}`, { method: 'PUT', body: JSON.stringify({ password }) });
  if (!up.ok) { console.error('Could not reset password:', await up.text()); process.exit(1); }
  console.log(`Login ${email} already existed; password reset`);
} else {
  console.error('Auth error:', res.status, body); process.exit(1);
}

// 2. Profile row with the role.
const db = new pg.Client({ connectionString: SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
try {
  await db.query(
    `insert into public.profiles (id, username, display_name, role, active) values ($1, $2, $3, $4, true)
     on conflict (id) do update set username = excluded.username, display_name = excluded.display_name,
       role = excluded.role, active = true`,
    [userId, username, name, role]);
  const { rows } = await db.query('select username, display_name, role, active from public.profiles where id = $1', [userId]);
  console.log('Profile:', rows[0]);
} finally {
  await db.end();
}
