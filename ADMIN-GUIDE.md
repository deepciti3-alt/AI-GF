# Running it

Sign in with the admin mobile and you land on the panel and nothing else — no chat, no companions, no settings. The admin account is a command centre, exactly like NutriWeb. Everything below lives behind those five tabs.

```
Admin mobile     9873393559
Admin password   987339
```

**Zero-setup mode (default).** With no Supabase keys filled in, the app runs on a built-in in-browser backend (`js/local.js`): the admin account above works out of the box, and the admin password is seeded from `js/local.js` → `window.GF_ADMIN.pass`. Change it there, or from **Settings → Change password** once signed in.

**Supabase mode.** Once you fill in your Supabase URL + anon key, change the number in `sql/SCHEMA.sql` → `gf_admin_emails()` **and** `js/admin.js` → `window.GF_ADMIN.phone`. Change the password from the login screen of a fresh account, or in Supabase → Authentication → Users.

---

## 👥 Users

Five counters across the top — total, active, on trial, blocked, expired — then every account listed by **mobile number**, with a status badge and a search box. Search accepts a number in any format, a name, or a coupon code.

### ＋ Add user

Give it a mobile number and a password (one is generated for you), pick how long they get, and press create. The account exists immediately — no email, no confirmation, nothing for them to click. The number and password are then shown once, big, with a copy button. That's the only time the password is visible, so send it before you close the card.

How it works underneath: the browser cannot create auth users on the main client without swapping *your* session for the new one, so `supabase.js` runs the signup on a detached, throwaway client and then seeds the profile through an admin-only RPC. No `service_role` key is involved anywhere.

People can also sign themselves up from the login screen and land on the normal free trial. Both routes end in the same place.

### Manage

| Action | What it does |
|---|---|
| Grant · 7 / 10 / 30 / 90 / 365 days | Access runs from *today*, replacing whatever they had |
| ♾️ Lifetime | Never expires |
| Extend +7 / +30 / +90 / +365 | Stacks on what they already have, never back-dates |
| Restart trial | Fresh trial |
| Expire now | Cuts them off immediately |
| Block / Unblock | A hard stop regardless of paid time left |

Every change is written to `gf_admin_log` with your number against it.

---

## 🎟️ Coupons

Type a code (or take the generated one), set days and how many people can use it.

- **Days ≤ 0** → lifetime access
- **Max uses ≤ 0** → unlimited redemptions
- One redemption per person per code, always — enforced by a unique index, not by the interface
- Redeeming **stacks**: a 30-day code on top of 12 remaining days gives 42

**Disable** stops a code working without deleting it. **Delete** removes it — anyone who already redeemed keeps their access, the code just stops working.

Redemption runs in one transaction with the coupon row locked, so two people racing for the last use can't both win.

---

## 🔑 AI Keys

The important screen, and the only place in the whole app where a key exists.

Add keys in the order you want them tried. **Key #1 is primary.** If it hits a rate limit, expires, or the provider falls over, the app silently rolls to #2, then #3 — mid-conversation, without the user noticing. Only *retryable* failures rotate; a genuine bug is surfaced rather than masked.

- **⚡ Test and add** makes a real round-trip before saving. A dead key is never added.
- Paste a key with no provider selected and it's detected from the prefix (`AIza` → Gemini, `sk-ant-` → Claude, `gsk_` → Groq, `sk-or-` → OpenRouter, `sk-` → OpenAI). `sk-` is ambiguous between OpenAI and DeepSeek, so a failed first guess silently tries the other.
- **↑** promotes · **⚡** re-tests · **✕** removes.
- **Kill switch** switches everyone to offline without deleting anything.

Everyone signed in *with access* gets this list at runtime. **Users have no API surface at all** — no provider picker, no key field, no model box, no test button. Their Settings page says "Ready" or "Not available yet" and that's it. No key is ever written to anyone's device storage or into their cloud backup.

**On providers and the spicy mood.** Anthropic and OpenAI apply their own content policies no matter what the prompt says. If she starts feeling flattened, that's the provider, not the app. DeepSeek, Groq and OpenRouter's uncensored models handle it without complaint — add one and promote it to #1.

---

## 💋 Personas

Anything you build or clone can be pushed out as a personality every user gets. **Publish to everyone**; **Hide** takes her out of the list without deleting. Conversations people already had with her stay on their devices.

Only the personality travels. Chats and memories never leave the user's own account.

---

## ⚙️ Config

- **Trial days** — what a new signup gets. Set 0 and nobody gets in without a coupon or without you adding them.
- **Announcement** — a line on everyone's Settings page.
- **Adult mode, globally** — on by default. Off caps *every* account at flirty regardless of their own setting.
- **Bulk actions** — unblock everyone, or expire everyone (lifetime accounts skipped).
- **Health** — project URL, admin mobile, key count, user count, last config change.

---

## The security model, briefly

Two rules pulling in opposite directions, on purpose.

**Fail open on the client.** `hasAccess()` returns *true* whenever it's uncertain — no profile yet, network down, request in flight. A dropped connection must never lock out someone who paid.

**Fail closed on the server.** `gf_get_config()` returns `{ok:false}` whenever *it* is uncertain. The browser lock is cosmetic — someone who edits the JavaScript to skip the gate gets an app with no key and nothing to talk to.

On top: RLS on every table; every privileged operation is a `SECURITY DEFINER` function that re-checks `gf_is_admin()` itself; those functions have `EXECUTE` revoked from `anon`; and a `BEFORE UPDATE` trigger on `gf_profiles` reverts the privileged columns for anyone who isn't an admin. The only way past that trigger is a transaction-local setting only the trusted functions apply.

Expiry is never judged against the device clock — `gf_bootstrap` returns `server_time` and the client offsets every calculation by the difference. Changing your laptop's date does nothing.

**What the admin cannot do:** read anyone's conversations. `gf_state` has no admin read policy. Deliberate, and enforced in the database rather than the interface.
