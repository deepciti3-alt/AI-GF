# Cloud setup

**You do not need this to get login, the admin panel, coupons and multi-API keys.** Out of the box, with no keys filled in, the app runs on a built-in in-browser backend (`js/local.js`): open the site, sign in as admin (`9873393559` / `987339`), and everything works on that one device. Coupons, users, and the shared API-key list are all live.

Do this cloud setup **only when you want many users across many devices** — real accounts that follow people from phone to laptop, with server-side security. Twenty minutes, once. When you're done you have mobile-number login, a free trial, a paywall, coupon codes, centrally managed API keys, and an admin panel — all synced through Supabase.

---

## 1 · Make the project

1. [supabase.com](https://supabase.com) → **New project**.
2. Name it anything. Let it generate the database password and save it somewhere.
3. Nearest region — for India, Mumbai (`ap-south-1`).
4. Wait for it to provision.

## 2 · Copy the two values you need

**Settings → API**:

- **Project URL** — `https://abcdefghijkl.supabase.co`
- **anon public** key — a long `eyJ...` string

> ⚠️ There is also a **service_role** key on that page. Never put it in this app or any file you upload. It bypasses every security rule in the schema.
>
> The **anon** key is meant to be public. Everything that matters is enforced by row-level security and by the `SECURITY DEFINER` functions in `SCHEMA.sql`.

## 3 · Set the admin mobile number

Open `sql/SCHEMA.sql` and set it near the top. Note the `@ariaos.app` suffix — that's the internal address the number maps to:

```sql
create or replace function public.gf_admin_emails()
returns text[] language sql immutable as $$
  select array[
    '9873393559@ariaos.app'        -- << admin mobile
  ]::text[];
$$;
```

Add more admins by adding more entries, comma separated.

Then open `js/admin.js` and set the **same number**:

```js
window.GF_ADMIN = {
  phone: '9873393559',
  pass:  '987339',
  name:  'Admin',
};
```

The SQL one is the real check. The JavaScript one only stops the admin seeing a flash of "access denied" while the first request is in flight.

## 4 · Run the schema

**SQL Editor → New query** → paste the whole of `sql/SCHEMA.sql` → **Run**.

It ends with a `select` listing twelve `gf_*` functions. If you see them, you're done. Safe to run again any time.

## 5 · Paste the keys into the app

`js/supabase.js`, the block at the top:

```js
const GF_SUPABASE = {
  url:     'https://abcdefghijkl.supabase.co',
  anonKey: 'eyJhbGciOi...',
};
```

The app auto-detects this. The moment both are filled in, the mobile login screen and the admin panel appear on their own.

## 6 · Auth settings — the important step

**Authentication → Providers → Email** → **enabled**.

Then **turn "Confirm email" OFF.** This is not optional.

Login is by mobile number, and the number is carried internally as `9873393559@ariaos.app` — an address that does not exist and never receives mail. If Supabase is waiting for someone to click a confirmation link, nobody can ever sign in. With it off, a new account works the instant it's created.

(This is why there's no SMS provider and no OTP. Supabase's native phone auth needs a paid SMS gateway; this approach needs nothing and costs nothing.)

You do **not** need to set Site URL or Redirect URLs — there are no email links anywhere in this app.

## 7 · Deploy

Any static host — it's plain files.

- **Vercel / Netlify** — drag the folder onto the dashboard.
- **cPanel / BigRock** — upload the folder into `public_html`, keeping `css/` and `js/` intact.
- **GitHub Pages** — push and enable Pages.

HTTPS is needed for the microphone, the service worker and the install prompt. All three give it free.

## 8 · First run

1. Open the site → **I'm new — make me an account** → mobile `9873393559`, password `987339`.
2. You land straight in the **admin panel**, and nothing else. That's correct — the admin account is a command centre, not a companion account.
3. **🔑 AI Keys** → add a key → **⚡ Test and add**.
4. **👥 Users → ＋ Add user** → make yourself a test account on a different number, then open it in another browser and check she talks.

From then on anyone who signs up gets a free trial (length is in **⚙️ Config**) and shares your keys. Nobody needs their own.

---

## Troubleshooting

| What you see | What it means |
|---|---|
| "Email confirmation is still switched on" | Step 6. Turn **Confirm email** off. |
| `Wrong number or password.` | Exactly that. Numbers are normalised, so `+91`, a leading `0` and a bare 10-digit number are all the same. |
| `That number already has an account` | Sign in rather than sign up. As admin you can reset their access, though not their password — have them use **Settings → Change password** once they're in. |
| `Could not find the function ... in the schema cache` | The schema ran but PostgREST hasn't noticed. Run `notify pgrst, 'reload schema';`. |
| `Admins only.` | The number you signed in with isn't in `gf_admin_emails()`. It must be there as `<digits>@ariaos.app`. |
| Everything times out | The project is paused — the free tier sleeps after 7 idle days. Open the dashboard and it wakes. |
| A user says the AI stopped | Check **🔑 AI Keys**. If their access lapsed, the server stops handing them a key on purpose — that's the paywall working. |

---

## What the schema creates

| Table | Holds | Who can read it |
|---|---|---|
| `gf_state` | one JSON blob per user — chats, memories, settings | **only that user.** Not even the admin. |
| `gf_profiles` | mobile, status, trial end, access expiry, coupon used | the user, and the admin |
| `gf_coupons` | code, days, max uses, used count | admin only |
| `gf_coupon_uses` | who redeemed what, when | admin, and the person themselves |
| `gf_config` | the API key envelope, trial length, announcement, global adult mode | admin only — users reach it through one gated function |
| `gf_personas` | personalities published to everyone | anyone signed in reads the live ones; admin writes |
| `gf_admin_log` | every access change and who made it | admin only |

The admin manages *access*, and cannot read anybody's conversations. That's deliberate, and it's enforced in the database rather than in the interface.
