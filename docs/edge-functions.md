# Edge functions

Server-side code that needs the secret key. The browser never sees that key; it calls the function
with the signed-in user's session, and the function checks who is calling.

| Function | Used by | Phase |
|---|---|---|
| `admin-users` | Users page (admin only): list, create, edit role/name, reset password, disable/enable | 1 |
| `cashier-view` | `cashier.html` PIN page | 4 |
| `extract-offer` | Promotions → Import from file or photo | 6 |

## Deploying `admin-users` (dashboard, no tools needed)

1. Supabase dashboard → **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name it exactly `admin-users`.
3. Replace the sample code with the contents of `supabase/functions/admin-users/index.ts`, then **Deploy**.
4. Open the function → **Details / Settings** → turn **Verify JWT** **off** → Save.
   (This project signs sessions with the newer asymmetric keys. The function checks the caller itself
   with `auth.getUser()`, then requires an active `admin` profile.)
5. Only if the Users page reports an auth/key error: **Edge Functions → Secrets** → add
   `LV_SECRET_KEY` = your `sb_secret_…` key. (By default the function uses the built-in
   `SUPABASE_SERVICE_ROLE_KEY`.)

Check: sign in as admin → Users. The "Read-only for now" notice disappears and **+ Add user** works.

## Deploying `cashier-view` (Phase 4)

Same steps as `admin-users`: name it exactly `cashier-view`, paste `supabase/functions/cashier-view/index.ts`,
Deploy, then turn **Verify JWT off** (the cashier page has no login). Needs migration 005 first.
The function only returns the chosen cashier's own days for the current or previous month (Beirut),
after `cashier_verify_pin()` accepts the PIN; 5 wrong PINs lock that cashier for 15 minutes.

Check: open `cashier.html`, pick a cashier who has a PIN (set under Cash → Cashiers & settings), type it.

## Deployment status

| Function | Deployed | How |
|---|---|---|
| `admin-users` | 2026-09-29 | CLI, `--no-verify-jwt` |
| `cashier-view` | 2026-09-29 | CLI, `--no-verify-jwt` |

## Setting up `extract-offer` (Phase 6)

1. Anthropic API key: console.anthropic.com → API Keys → Create key.
2. Supabase dashboard → Edge Functions → **Secrets** → add `ANTHROPIC_API_KEY` = that key.
   Optional: `ANTHROPIC_MODEL` (default `claude-opus-5`) to change the model without a code edit.
3. Deploy: `npx supabase functions deploy extract-offer --project-ref sezjqcbkiydckhirycjb --no-verify-jwt`
4. Needs migration 008 (barcodes + the private `promotion-offers` bucket).

On the default model the request enables the API's server-side refusal fallback (`fallbacks: "default"`):
if a request is declined by a safety check it is re-run on another Claude model instead of failing.
Each run is logged in the activity log (files, lines, model, tokens) by the page.

## Deploying with the CLI (alternative)

```sh
npx supabase login            # or: $env:SUPABASE_ACCESS_TOKEN = "sbp_..." (PowerShell)
npx supabase functions deploy admin-users --project-ref sezjqcbkiydckhirycjb --no-verify-jwt
npx supabase functions deploy cashier-view --project-ref sezjqcbkiydckhirycjb --no-verify-jwt
npx supabase functions deploy extract-offer --project-ref sezjqcbkiydckhirycjb --no-verify-jwt
```

Pitfalls seen:
- **"Access token not provided"**: run `npx supabase login` first, or set `SUPABASE_ACCESS_TOKEN`
  (supabase.com/dashboard/account/tokens).
- **"Missing required permission(s): edge_functions_write"**: the token was created without the
  Edge Functions write permission; make a new one with it. Delete deploy tokens after use.
- **Dashboard editor "Entrypoint path does not exist … index.ts"**: the editor must have exactly one
  top-level file named `index.ts`.
- "Docker is not running" is only a warning; deploying does not need Docker.

## Rules the function enforces

- Caller must be signed in, with an **active** profile whose role is **admin**.
- Usernames: 2–32 chars, `a-z 0-9 . _ -`; login email becomes `<username>@lvajaltoun.local`.
- Passwords: 8+ characters.
- You cannot demote or disable yourself, and the last active admin can never be demoted or disabled.
- Disabling also bans the Auth account, so existing sessions cannot refresh.
- Each action is written to `activity_log` by the page after it succeeds.
