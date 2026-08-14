# Connect a Supabase project — the easy way

You do **not** need this to use the app. Out of the box it already gives you
login, the admin panel, coupons and multi-API keys — all on one device
(`js/local.js`). Do this only when you want **real accounts across many
devices** (phone + laptop, many users), stored on a server.

There are exactly **two things** the app needs from Supabase, and **one SQL
file** to run. Then hand the prompt at the bottom to Claude and it wires
everything up for you.

---

## Step 1 — Make the project and copy 2 values (5 min)

1. Go to [supabase.com](https://supabase.com) → **New project**. Region: for
   India pick **Mumbai (ap-south-1)**. Let it finish provisioning.
2. Open **Settings → API** and copy these two:
   - **Project URL** — looks like `https://abcdefghijkl.supabase.co`
   - **anon public** key — a long string starting `eyJ...`

> ⚠️ On the same page there is a **service_role** key. **Never** copy or paste
> that anywhere in this app. The **anon** key is the safe, public one.

---

## Step 2 — The SQL to run

The complete database is already written for you in **`sql/SCHEMA.sql`** in
this repo, and the admin number is already set to **9873393559**.

In Supabase: **SQL Editor → New query** → paste the *entire* contents of
`sql/SCHEMA.sql` → **Run**. It's safe to run again any time. When it finishes
it lists a bunch of `gf_*` functions — that means it worked.

---

## Step 3 — Turn OFF email confirmation (don't skip)

In Supabase: **Authentication → Providers → Email** → make sure Email is
**enabled**, then turn **"Confirm email" OFF**.

Login is by mobile number (carried internally as `9873393559@ariaos.app`, an
address that never receives mail), so if Supabase waits for an email
confirmation, nobody can ever sign in. Off = accounts work instantly.

---

## Step 4 — Let Claude save the keys for you

Copy the prompt below, fill in your two values from Step 1, and paste it to
Claude (this extension). Claude will write them into `js/supabase.js`, check
the admin number matches in both places, and commit + push.

```
Wire my Supabase project into the Aria OS app.

Project URL:   PASTE_YOUR_PROJECT_URL_HERE
anon public:   PASTE_YOUR_ANON_KEY_HERE

Please do all of this for me:
1. Put those two values into js/supabase.js — set `url` and `anonKey`
   inside the GF_SUPABASE block at the top. Do not touch anything else there.
2. Confirm my admin mobile 9873393559 is set in BOTH:
   - sql/SCHEMA.sql  → gf_admin_emails()  (as 9873393559@ariaos.app)
   - js/admin.js     → window.GF_ADMIN.phone
   Fix either one if it doesn't match.
3. Verify the JS still parses (node --check) and give me a one-line summary
   of what changed.
4. Commit with a clear message and push to my branch.

I will run sql/SCHEMA.sql in the Supabase SQL editor myself, and I've turned
"Confirm email" OFF in Supabase Auth.
```

That's it. The moment both values are in `js/supabase.js`, the app switches
from the in-browser backend to your Supabase project automatically — the
same login screen and admin panel, now synced for every user on every device.

---

## Step 5 — First run on the cloud

1. Open your deployed site → **I'm new — make me an account** → mobile
   `9873393559`, password `987339`. You land in the **admin panel**.
2. **🔑 AI Keys** → paste a provider key → **⚡ Test and add**. Add as many as
   you like (Gemini, Groq, DeepSeek…). They're shared with everyone.
3. **👥 Users → ＋ Add user** to create accounts, or send people the link and
   they sign themselves up onto the free trial.
4. **🎟️ Coupons** → make codes for 7 days, 1 month, or lifetime.

Full day-to-day guide: `ADMIN-GUIDE.md`. Deeper setup notes and
troubleshooting: `SETUP-SUPABASE.md`.

---

### Optional: if you have the Supabase connector enabled in Claude

If your Claude has a Supabase integration/MCP connected, you can also add this
line to the prompt above and Claude can run the schema for you:

```
5. If you have access to my Supabase project through a connector, run the
   full contents of sql/SCHEMA.sql against it and confirm the gf_* functions
   were created. Otherwise, just tell me to run it myself.
```
