# Creating the first admin

Needs migration 001 applied (it creates `profiles`). Then, from the project folder:

```sh
node --env-file=.env scripts/create-admin.mjs --email <login email> --username <username> --name "<Full Name>" --password '<password>'
```

- Creates the Supabase Auth account (email pre-confirmed) and a `profiles` row with role `admin`.
- Safe to re-run: an existing account is reused, its password reset, and the profile set to active admin.
- Staff without email: omit `--email`; the login becomes `<username>@lvajaltoun.local` (PLAN §3).
  The login screen accepts either a full email or a plain username.
- Every other user is created from the app (Settings → Users) through the `admin-users` edge function.

Manual alternative: Supabase dashboard → Authentication → Add user (tick "Auto confirm"), copy the user id, then in the SQL Editor:
`insert into public.profiles (id, username, display_name, role) values ('<user id>', '<username>', '<name>', 'admin');`
