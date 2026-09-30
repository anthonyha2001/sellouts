// admin-users — create and manage staff logins. Only an active admin may call it.
// The service/secret key is read from the function's environment and never reaches a browser.
//
// POST body: { action, ... }
//   list                                                   -> { users: [...] }
//   create  { username, display_name, role, password }     -> { user }
//   update  { id, display_name?, role?, active? }          -> { user }
//   reset_password { id, password }                         -> { ok }
//   disable { id }                                          -> { user }
//
// Deploy with JWT verification OFF (this project signs user tokens with asymmetric keys);
// the function verifies the caller itself with auth.getUser(token). See docs/edge-functions.md.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
// LV_SECRET_KEY (optional secret, sb_secret_...) wins over the built-in legacy service role key.
const SERVICE_KEY = Deno.env.get('LV_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const LOGIN_DOMAIN = 'lvajaltoun.local';
const ROLES = ['admin', 'accountant', 'delivery', 'floor_manager', 'shelf', 'hr'];
const USERNAME_RE = /^[a-z0-9._-]{2,32}$/;
const MIN_PASSWORD = 8;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const fail = (message: string, status = 400) => json({ error: message }, status);

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

type Profile = { id: string; username: string; display_name: string | null; role: string; active: boolean; created_at: string };

async function otherActiveAdmins(exceptId: string) {
  const { count } = await admin.from('profiles').select('id', { count: 'exact', head: true })
    .eq('role', 'admin').eq('active', true).neq('id', exceptId);
  return count ?? 0;
}

async function setBanned(id: string, banned: boolean) {
  // A ban stops the account from signing in or refreshing its session.
  const { error } = await admin.auth.admin.updateUserById(id, { ban_duration: banned ? '876000h' : 'none' });
  if (error) throw error;
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail('Method not allowed', 405);

  // 1. Who is calling?
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return fail('Not signed in', 401);
  const { data: { user: caller }, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !caller) return fail('Not signed in', 401);
  const { data: me } = await admin.from('profiles').select('*').eq('id', caller.id).maybeSingle();
  if (!me || !me.active || me.role !== 'admin') return fail('Only an admin can manage users', 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return fail('Bad request'); }
  const action = String(body.action ?? '');

  try {
    if (action === 'list') {
      const { data: profiles, error } = await admin.from('profiles').select('*').order('created_at');
      if (error) throw error;
      const { data: authList, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1000 });
      if (listErr) throw listErr;
      const byId = new Map(authList.users.map(u => [u.id, u]));
      const users = (profiles as Profile[]).map(p => {
        const u = byId.get(p.id);
        return { ...p, email: u?.email ?? null, last_sign_in_at: u?.last_sign_in_at ?? null };
      });
      return json({ users });
    }

    if (action === 'create') {
      const username = String(body.username ?? '').trim().toLowerCase();
      const display_name = String(body.display_name ?? '').trim() || null;
      const role = String(body.role ?? '');
      const password = String(body.password ?? '');
      if (!USERNAME_RE.test(username)) return fail('Username: 2–32 characters, lowercase letters, numbers, dot, dash or underscore.');
      if (!ROLES.includes(role)) return fail('Unknown role.');
      if (password.length < MIN_PASSWORD) return fail(`Password must be at least ${MIN_PASSWORD} characters.`);
      const { data: taken } = await admin.from('profiles').select('id').eq('username', username).maybeSingle();
      if (taken) return fail(`The username "${username}" is already used.`);

      const email = `${username}@${LOGIN_DOMAIN}`;
      const { data: created, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { username },
      });
      if (error) return fail(/already/i.test(error.message) ? `A login for "${username}" already exists.` : error.message);
      const { data: profile, error: pErr } = await admin.from('profiles')
        .insert({ id: created.user.id, username, display_name, role, active: true }).select().single();
      if (pErr) {
        await admin.auth.admin.deleteUser(created.user.id);   // don't leave a login without a profile
        throw pErr;
      }
      return json({ user: { ...profile, email, last_sign_in_at: null } });
    }

    const id = String(body.id ?? '');
    if (!id) return fail('Missing user id.');
    const { data: target } = await admin.from('profiles').select('*').eq('id', id).maybeSingle();
    if (!target) return fail('User not found.', 404);

    if (action === 'update' || action === 'disable') {
      const patch: Partial<Profile> = {};
      if (action === 'disable') patch.active = false;
      if (action === 'update') {
        if (body.display_name !== undefined) patch.display_name = String(body.display_name).trim() || null;
        if (body.role !== undefined) {
          if (!ROLES.includes(String(body.role))) return fail('Unknown role.');
          patch.role = String(body.role);
        }
        if (body.active !== undefined) patch.active = !!body.active;
      }
      const losesAdmin = target.role === 'admin' && target.active &&
        ((patch.role && patch.role !== 'admin') || patch.active === false);
      if (losesAdmin && id === me.id) return fail('You cannot remove your own admin access or disable yourself.');
      if (losesAdmin && (await otherActiveAdmins(id)) === 0) return fail('There must always be at least one active admin.');

      const { data: updated, error } = await admin.from('profiles').update(patch).eq('id', id).select().single();
      if (error) throw error;
      if (patch.active !== undefined && patch.active !== target.active) await setBanned(id, !patch.active);
      return json({ user: updated });
    }

    if (action === 'reset_password') {
      const password = String(body.password ?? '');
      if (password.length < MIN_PASSWORD) return fail(`Password must be at least ${MIN_PASSWORD} characters.`);
      const { error } = await admin.auth.admin.updateUserById(id, { password });
      if (error) throw error;
      return json({ ok: true });
    }

    return fail('Unknown action.');
  } catch (e) {
    console.error(action, e);
    return fail((e as Error)?.message ?? 'Server error', 500);
  }
});
