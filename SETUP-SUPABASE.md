# Cloud setup

Twenty minutes, once. When you're done you have accounts, a free trial, a paywall, coupon codes, centrally managed API keys, and an admin panel.

Skip this entirely if you just want the app on your own machine — it runs perfectly happily local-only.

---

## 1 · Make the project

1. Go to [supabase.com](https://supabase.com) → **New project**.
2. Name it anything. Let it generate the database password and save it somewhere.
3. Pick the region nearest you — for India, Mumbai (`ap-south-1`).
4. Wait for it to finish provisioning.

## 2 · Copy the two values you need

**Settings → API**:

- **Project URL** — looks like `https://abcdefghijkl.supabase.co`
- **anon public** key — a long `eyJ...` string

> ⚠️ There is also a **service_role** key on that page. Never put it in this app, or in any file you upload to a web host. It bypasses every security rule in the schema.
>
> The **anon** key is designed to be public. Everything that actually matters is enforced by row-level security and by the `SECURITY DEFINER` functions in `SCHEMA.sql`.

## 3 · Set the admin email

Open `sql/SCHEMA.sql` and change this, near the top:

```sql
create or replace function public.gf_admin_emails()
returns text[] language sql immutable as $$
  select array[
    'grivaaseo@gmail.com'          -- << CHANGE ME
  ]::text[];
$$;
```

You can list several, comma separated. Then open `js/admin.js` and set the **same** email:

```js
window.GF_ADMIN = {
  email: 'grivaaseo@gmail.com',
  name:  'Abhishek',
};
```

The SQL one is the real check. The JavaScript one only stops an admin seeing a flash of "access denied" while the first request is in flight.

## 4 · Run the schema

**SQL Editor → New query** → paste the whole of `sql/SCHEMA.sql` → **Run**.

It ends with a `select` that should list nine `gf_*` functions. If you see them, you're done. It is safe to run again any time.

## 5 · Paste the keys into the app

Open `js/supabase.js` and fill in the block at the top:

```js
const GF_SUPABASE = {
  url:     'https://abcdefghijkl.supabase.co',
  anonKey: 'eyJhbGciOi...',
};
```

The app auto-detects this. As soon as both are filled in, the login screen and the admin panel appear on their own.

## 6 · Turn on email auth

**Authentication → Providers → Email** → enabled.

While you're testing, **Authentication → Providers → Email → Confirm email → off**. Turn it back on before you give the link to anyone.

**Authentication → URL Configuration**: set **Site URL** and add your live domain to **Redirect URLs**. Password reset links will not come back to the app without this.

Phone OTP is wired up in `supabase.js` if you want it, but it needs a paid SMS provider (Twilio or MessageBird) configured in Supabase first.

## 7 · Deploy

Any static host works — it's plain files.

- **Vercel / Netlify** — drag the folder onto the dashboard. Done.
- **cPanel / BigRock** — upload the whole folder into `public_html`, keeping the structure. Make sure `css/` and `js/` come along.
- **GitHub Pages** — push the folder, enable Pages.

The app needs HTTPS for the microphone, the service worker and the install prompt. Every host above gives you that for free.

## 8 · First run

1. Open the site → **Make an account** with your admin email.
2. You should land straight in with an **Admin** item in the sidebar.
3. **Admin → 🔑 AI Keys** → add a key → **⚡ Test and add**.
4. **Admin → 🎟️ Coupons** → make one and try redeeming it from another browser.

From that point everyone who signs up gets a 7-day trial (change it in **Admin → ⚙️ Config**) and shares your keys. Nobody needs their own.

---

## Troubleshooting

| What you see | What it means |
|---|---|
| `Could not find the function ... in the schema cache` | The schema ran but PostgREST hasn't noticed. Run `notify pgrst, 'reload schema';` in the SQL editor. |
| `Admins only.` | The email you signed in with isn't in `gf_admin_emails()`. Fix the function, re-run it, then reload the schema cache. |
| Login screen won't appear | `url` or `anonKey` is still blank in `js/supabase.js`, or there's a typo. |
| Everything times out | The project is paused. The free tier sleeps after 7 idle days — open the Supabase dashboard and it wakes. |
| Reset emails go nowhere useful | **Authentication → URL Configuration** — Site URL and Redirect URLs aren't set. |
| A user says the AI stopped working | Check **Admin → 🔑 AI Keys**. If someone's access lapsed, the server stops handing them a key on purpose — that's the paywall doing its job. |

---

## What the schema actually creates

| Table | Holds | Who can read it |
|---|---|---|
| `gf_state` | one JSON blob per user — chats, memories, settings | **only that user.** Not even the admin. |
| `gf_profiles` | status, trial end, access expiry, coupon used | the user, and the admin |
| `gf_coupons` | code, days, max uses, used count | admin only |
| `gf_coupon_uses` | who redeemed what, when | admin, and the person themselves |
| `gf_config` | the API key envelope, trial length, announcement, global adult mode | admin only — users reach it through one gated function |
| `gf_personas` | personalities you publish to everyone | anyone signed in reads the live ones; admin writes |
| `gf_admin_log` | every access change, and who made it | admin only |

The admin can manage *access*, and cannot read anybody's conversations. That's deliberate and it's enforced in the database, not in the UI.
