# Running it

Everything here lives behind the **Admin** item in the sidebar, which only appears for the email in `gf_admin_emails()`.

---

## 👥 Users

Five counters across the top — total, active, on trial, blocked, expired — then every account with a status badge and a search box.

**Manage** on any row opens the access sheet:

| Action | What it does |
|---|---|
| Grant · 7 / 10 / 30 / 90 / 365 days | Access runs from *today*, replacing whatever they had |
| ♾️ Lifetime | Never expires |
| Extend +7 / +30 / +90 / +365 | Stacks on top of what they already have, never back-dates |
| Restart trial | Puts them back on a fresh trial |
| Expire now | Cuts them off immediately |
| Block / Unblock | Block is a hard stop regardless of any paid time left |

Every change is written to `gf_admin_log` with your email against it.

---

## 🎟️ Coupons

Type a code (or take the generated one), set the days and how many people can use it.

- **Days ≤ 0** → lifetime access
- **Max uses ≤ 0** → unlimited redemptions
- One redemption per person per code, always — enforced by a unique index, not by the UI
- Redeeming **stacks**: a 30-day code on top of 12 remaining days gives 42, not 30

**Disable** stops a code working without deleting it. **Delete** removes it entirely — anyone who already redeemed it keeps their access; the code just stops working.

The redemption runs inside one database transaction with the coupon row locked, so two people racing for the last use of a code can't both win.

---

## 🔑 AI Keys

The important screen.

Add keys in the order you want them tried. **Key #1 is primary.** If it hits a rate limit, expires, or the provider falls over, the app silently rolls to #2, then #3 — mid-conversation, without the user noticing. Only *retryable* failures rotate; a genuine bug is surfaced rather than masked.

- **⚡ Test and add** makes a real round-trip to the provider before saving. If the key is dead, it is never added.
- Paste a key with no provider selected and it detects one from the prefix (`AIza` → Gemini, `sk-ant-` → Claude, `gsk_` → Groq, `sk-or-` → OpenRouter, `sk-` → OpenAI). `sk-` is ambiguous between OpenAI and DeepSeek, so if the first guess fails it silently tries the other one.
- **↑** promotes a key. **⚡** re-tests one. **✕** removes it.
- **Kill switch** switches everyone to offline without deleting anything. Flip it back and the same list returns.

Everyone signed in *with access* gets this list at runtime. Nobody needs their own key, and no key is ever written to anyone's device storage or into their cloud backup.

**A note on providers and the spicy mood.** Anthropic and OpenAI apply their own content policies no matter what the prompt says. If she starts feeling flattened in the spicy mood, that's the provider. DeepSeek, Groq and OpenRouter's uncensored models handle it without complaint, and switching is one key away — add one and promote it to #1.

---

## 💋 Personas

Anything you build or clone on your own account can be pushed out as a personality every user gets.

Build her (or clone her from a chat), then **Admin → Personas → Publish to everyone**. **Hide** takes her out of the list without deleting; conversations people already had with her stay on their devices.

Only the personality travels. Chats and memories never leave the user's own account.

---

## ⚙️ Config

- **Trial days** — what a new signup gets. Set 0 and nobody gets in without a coupon.
- **Announcement** — a line on everyone's Settings page. Empty shows nothing.
- **Adult mode, globally** — on by default. Turning it off caps *every* account at flirty regardless of what they set on their own device.
- **Bulk actions** — unblock everyone, or expire everyone (lifetime accounts are skipped). These loop one account at a time, so a long list takes a moment.
- **Health** — project URL, admin email, key count, user count, when the config last changed.

---

## The security model, briefly

Two rules, and they pull in opposite directions on purpose.

**Fail open on the client.** `hasAccess()` returns *true* whenever it's uncertain — no profile yet, network down, request in flight. A dropped connection must never lock out someone who paid.

**Fail closed on the server.** `gf_get_config()` returns `{ok:false}` whenever *it* is uncertain. So the browser lock is cosmetic — someone who edits the JavaScript to bypass the gate gets an app with no API key and nothing to talk to.

On top of that: every table has row-level security; every privileged operation is a `SECURITY DEFINER` function that re-checks `gf_is_admin()` itself; those functions have `EXECUTE` revoked from `anon`; and a `BEFORE UPDATE` trigger on `gf_profiles` reverts the privileged columns for anyone who isn't an admin. The only way past that trigger is a transaction-local setting that only the trusted functions apply.

Expiry is never judged against the device clock either — `gf_bootstrap` returns `server_time`, and the client offsets every calculation by the difference. Changing your laptop's date does nothing.

**What the admin cannot do:** read anyone's conversations. `gf_state` has no admin read policy. That's deliberate, and it's enforced in the database rather than by the interface.
