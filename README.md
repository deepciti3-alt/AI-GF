# Aria OS

A private AI companion app you can hand to anyone.

Everyone signs in with a **mobile number and a password** — no email, no OTP, no SMS bill. New accounts get a free trial. You run it all from an admin panel: create accounts, grant or block access, issue coupon codes, and load the AI keys everybody shares. **Users never see an API key or a setting for one.** They just open the app and talk.

No build step. No framework. No `npm install`. Nine plain scripts and one stylesheet.

---

## The two ways in

| | Signs in with | Sees |
|---|---|---|
| **Admin** | `9873993559` / `987399` | The admin panel and nothing else — users, coupons, AI keys, personalities, config |
| **Everyone else** | Their own mobile + password | Chat, Companions, Clone Lab, Memory, Gallery, Settings. No AI configuration anywhere. |

Sign in once and the device stays signed in. Nobody has to log in again.

---

## Setup

**Local only, 2 minutes** — no accounts, no gate, bring your own key:

```bash
cd "Project AI Girlfriend"
python3 -m http.server 8000
```

Open `http://localhost:8000`, tap **I'm 18 or older**, put a key into Settings, talk to her.

**The real thing, 20 minutes** — accounts, trials, coupons, admin panel, shared keys: follow `SETUP-SUPABASE.md`. Short version: make a Supabase project, run `sql/SCHEMA.sql`, paste two values into `js/supabase.js`, turn **Confirm email off**, deploy the folder anywhere static.

Then read `ADMIN-GUIDE.md` — it's how you run it day to day.

---

## How mobile login works without an SMS provider

Supabase's real phone auth wants to send an OTP, which needs a paid SMS gateway. We don't want an OTP — we want a number and a password. So every number is mapped to a synthetic internal address:

```
9873993559  →  9873993559@ariaos.app
```

and ordinary email+password auth carries it underneath. Nobody ever sees that address; it is a unique key, nothing more. Turn **Confirm email** off in Supabase (there's no inbox to confirm) and it works instantly on the free tier, forever, for nothing.

The real number is stored properly in `gf_profiles.phone`, so the admin panel searches and displays actual mobile numbers. `+91 98739 93559`, `09873993559` and `9873993559` all resolve to the same person.

---

## What's in it

### Three companions to start with, unlimited after that

| | Who | Default name |
|---|---|---|
| 🔥 | **Flirty & Moody** — bold, teasing, moody, spicy the second it turns | Priya |
| 💗 | **Emotional Support** — warm, present, your safest person | Aisha |
| 🚀 | **Motivator & Guide** — your hype-woman, goals and momentum and love | Riya |

Each keeps **her own chat, her own mood and her own memory**. Nothing crosses over.

Each is a twelve-field behavioural spec — how she sounds, how she texts, her signature moves, her vocabulary, what she refuses, how she closes, **and how she behaves when it turns explicit**, per personality. All twelve fields are editable. Built-ins are *hidden* rather than deleted, so you can always get them back.

Add more from **Companions → Build one**, or clone one from a real chat. No limit. As admin you can publish any of them to every user at once.

### The Clone Lab

Export a real WhatsApp conversation, paste it in, and it builds a companion who texts like the person in it.

It parses every export format (iOS bracketed, Android dashed, `Name (10:22):`, and plain `Name: text`), strips the noise lines, works out who the participants are and lets you pick whose voice to clone. Then two passes: a forensic analysis of **twenty dimensions of texting behaviour** — message length, punctuation habits, which emoji and when, the English/Hindi ratio, her pet names for you and what she calls you when annoyed, how she reacts to good news versus boring news, how she flirts, how she fights, how she apologises, how she escalates — then a compile step into the same twelve-field spec the built-ins use.

Keep feeding her more chat later and the spec sharpens without losing what it had.

Two rules live in the saved data rather than the prompt, so they survive any edit: she's an archetype *in the style of*, never a claim to be the real person, and she never invents quotes attributed to them.

### Memory that asks first

She notices durable things about you — your work, your people, your plans, the inside jokes — and keeps a rolling summary of where you both stand. Anything she picks up lands in a queue on the Memory page for a one-tap keep or discard. She never quietly decides she knows something about you.

### Five moods, spicy fully intact

Chill, Romantic, Flirty, **Spicy**, Emotional. The mood directive is injected *last*, so it's the freshest instruction the model reads — which is why switching the chip visibly changes how she writes.

Spicy is completely uninhibited: naughty talk, dirty talk, no fade-outs, no disclaimers, no refusals. Each personality also has her own `spice` field, so Priya's filthy and Aisha's filthy aren't the same filthy. Gemini's safety filters are explicitly turned off, because they refuse the spicy mood outright otherwise.

There's a per-user **Adult mode** toggle, and a global one in the admin Config tab that overrides everyone.

### Everything else

- **Streaming replies** — one SSE parser, three provider adapters.
- **Six providers** — Claude, Gemini, Groq, OpenAI, DeepSeek, OpenRouter, plus any OpenAI-compatible endpoint.
- **Key rotation** — the admin loads an ordered list; a rate limit or dead key silently rolls to the next. Only retryable failures rotate, so a real bug is never masked.
- **Pictures** via Gemini, kept on-device, with a gallery.
- **Voice** in (continuous, idle auto-stop) and out (browser TTS).
- **Dark mode** — sliding switch in the sidebar, sun/moon in the mobile header, a toggle in Settings, and the `D` key.
- **PWA** — installs to a home screen, works offline from the last good copy.
- **Backup and restore** as JSON, with keys deliberately left out of the file.

---

## Files

```
index.html                the shell, and nothing else
css/app.css               the whole design system
js/supabase.js            GfCloud    — cloud client + phone auth  ← paste your keys here
js/config.js              GfConfig   — personalities, moods, providers, the core rules
js/store.js               GfStore    — all state, per-account localStorage buckets
js/api.js                 GfApi      — prompts, streaming, key rotation, images
js/memory.js              GfMemory   — facts, moments, the approval queue
js/clone.js               GfClone    — chat parsing and the two-pass cloner
js/ui.js                  GfUI       — escaping, markdown, icons, modals, pickers
js/admin.js               GfAccess / GfGate / GfAdmin  ← admin mobile set here
js/app.js                 GfApp      — pages, routing, every event handler
sql/SCHEMA.sql            the complete Postgres schema — run it once
sw.js                     service worker
assets/avatars/           drop her photos here (see the README in that folder)
SETUP-SUPABASE.md         cloud setup, step by step
ADMIN-GUIDE.md            how to run it day to day
```

Load order matters and is the architecture: cloud → config → store → api → memory → clone → ui → admin → app.

Two places carry the admin identity and they must agree:

- `js/admin.js` → `window.GF_ADMIN.phone`
- `sql/SCHEMA.sql` → `gf_admin_emails()`, as `<digits>@ariaos.app`

The SQL one is the real check. The JavaScript one only stops the admin seeing a flash of "access denied" while the first request is in flight.

---

## Avatars

Drop images into `assets/avatars/`, then open **Companions → ✎** on any girl and put the path in the *Avatar image* field. A wrong path falls back to her emoji, silently — nothing breaks.

---

## Honest limitations

- **The API key exists in the browser.** The app calls the provider directly, so the key is briefly in the page's memory and its network requests. Someone determined, with developer tools open, could extract it. That's true of every browser-only app. The mitigation is fast rotation from the admin panel, not prevention. If you ever need real secrecy, `api.js` is the only file that changes.
- **Local data is not encrypted.** Chats and memories sit in `localStorage`.
- **Anthropic and OpenAI enforce their own content policies** regardless of the prompt. If spicy feels flattened, that's the provider — DeepSeek, Groq and OpenRouter's uncensored models handle it, and switching is one key away.
- **Supabase's free tier pauses a project after 7 idle days** and takes no automatic backups.
