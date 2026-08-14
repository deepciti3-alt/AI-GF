# Aria OS

A private AI companion, rebuilt out of the three projects you had lying around.

- The **girlfriend engine** — moods, memory, the uninhibited spicy register — comes from your existing AI GF app, kept whole.
- The **look and the architecture** come from Assistant (Advisor OS): the navy-and-red design system, the rail-plus-bottom-nav shell, the bottom-sheet pickers, the layered prompt, and the style-cloning idea.
- The **admin, Supabase, coupons and multi-API layer** come from NutriWeb, ported table for table.

No build step. No framework. No `npm install`. Nine plain scripts and one stylesheet — upload the folder to any static host and it runs.

---

## Quick start (5 minutes, no server)

1. Serve the folder. It works from `file://` too, but a real origin gets you the microphone, the service worker and the install prompt:
   ```bash
   cd "Project AI Girlfriend"
   python3 -m http.server 8000
   ```
   Then open `http://localhost:8000`.
2. Tap **I'm 18 or older**.
3. **Settings → Your API key** → pick a provider, paste a key, hit **Load the model list**, then **Test connection**.
4. Go to **Chat** and talk to her.

That's the whole app running local-only. Nothing is gated, there is no login, and everything lives in your browser.

To turn on accounts, the paywall, coupons and the admin panel, do the cloud setup — see `SETUP-SUPABASE.md`.

---

## What's in it

### Three personalities to start with — add as many as you like

Same three as the original app:

| | Who | Default name |
|---|---|---|
| 🔥 | **Flirty & Moody** — bold, teasing, moody, spicy the second it turns | Priya |
| 💗 | **Emotional Support** — warm, present, your safest person | Aisha |
| 🚀 | **Motivator & Guide** — your hype-woman, goals and momentum and love | Riya |

Each one keeps **her own chat, her own mood and her own memory**. Nothing crosses over.

Every one of them is a twelve-field behavioural spec — how she sounds, how she texts, her signature moves, her vocabulary, what she refuses, how she closes, **and how she behaves when it turns explicit**. All twelve fields are editable, and built-ins are *hidden* rather than deleted so you can always get them back.

To add more: **Companions → Build one** fills in the same twelve fields by hand, or the **Clone Lab** builds one from a real conversation. There is no limit.

### The Clone Lab

Export a real WhatsApp conversation, paste it in, and it builds a companion who texts like the person in it.

It parses every WhatsApp export format (iOS bracketed, Android dashed, the older `Name (10:22):` shape, and plain `Name: text`), strips the noise lines, works out who the participants are, and lets you pick whose voice to clone. Then two passes:

1. **A forensic texting analysis** — average message length, punctuation habits, which emoji and when, the English/Hindi ratio, her pet names for you, how she opens, how she reacts to good and bad news, exactly how she flirts, how she gets annoyed, how she apologises, how she escalates, how she says goodnight.
2. **A compile step** that turns that analysis into the same twelve-field spec every built-in personality uses — so a cloned girl and a built-in girl are literally the same kind of object and the same code renders both.

You can keep feeding her more chat later (**Inspect → Feed it more chat**) and the spec gets sharper without losing what it already had.

Two rules are baked into the saved data rather than the prompt, so they survive any prompt edit: she is an archetype *in the style of*, never a claim to be the real person, and she never invents quotes and attributes them to them.

### Memory that asks first

She notices durable things about you as you talk — your work, your people, your plans, the inside jokes — and keeps a rolling one-line summary of where the two of you stand.

The change from the original: **extraction proposes, it does not commit.** Anything she picks up lands in a queue on the Memory page for a one-tap keep or discard. She never quietly decides she knows something about you.

### Five moods, and the spicy one is intact

Chill, Romantic, Flirty, **Spicy**, Emotional. The mood directive is injected *last*, so it is the freshest instruction the model reads — which is why switching the chip visibly changes how she writes.

The spicy register is exactly as uninhibited as it was in the original, and every personality has her own `spice` field describing how *she specifically* gets dirty. Gemini's safety filters are explicitly turned off for this app, because they refuse the spicy mood outright otherwise.

There is a per-user **Adult mode** toggle in Settings, and a global one in the admin Config tab that overrides everyone.

### Everything else

- **Streaming replies** — one SSE parser, three provider adapters. Words appear as she types them.
- **Six providers** — Claude, Gemini, Groq, OpenAI, DeepSeek, OpenRouter, plus any OpenAI-compatible endpoint.
- **Key rotation** — the admin loads an ordered list of keys; a rate limit or a dead key silently rolls to the next one. Only retryable failures rotate, so a real bug is never masked.
- **Pictures** via Gemini, kept on-device, with a gallery.
- **Voice** in (Web Speech, continuous with an idle auto-stop) and out (browser TTS).
- **Light and dark**, with a one-tap switch in the sidebar (and the `D` key), plus two skins — the navy/red brand look, and the pastel Aurora one underneath it.
- **PWA** — installs to a home screen, works offline from the last good copy.
- **Backup and restore** as JSON, with API keys deliberately left out of the file.

---

## Files

```
index.html                the shell, and nothing else
css/app.css               the whole design system
js/supabase.js            GfCloud    — cloud client (paste your keys at the top)
js/config.js              GfConfig   — personalities, moods, providers, the core rules
js/store.js               GfStore    — all state, per-account localStorage buckets
js/api.js                 GfApi      — prompts, streaming, key rotation, images
js/memory.js              GfMemory   — facts, moments, the approval queue
js/clone.js               GfClone    — chat parsing and the two-pass cloner
js/ui.js                  GfUI       — escaping, markdown, icons, modals, pickers
js/admin.js               GfAccess / GfGate / GfAdmin
js/app.js                 GfApp      — pages, routing, every event handler
sql/SCHEMA.sql            the complete Postgres schema — run it once
sw.js                     service worker
assets/avatars/           drop her photos here (see the README in that folder)
SETUP-SUPABASE.md         cloud setup, step by step
ADMIN-GUIDE.md            how to run it once it's live
```

Load order matters and is the architecture: cloud → config → store → api → memory → clone → ui → admin → app.

---

## Avatars

Nothing is wired up yet — you said you'd add the images. Drop them into `assets/avatars/`, then open **Companions → ✎** on any girl and put the path in the *Avatar image* field. `assets/avatars/README.txt` lists suggested filenames. If a path is wrong she quietly falls back to her emoji; nothing breaks.

---

## Honest limitations

- **The API key exists in the browser.** The app calls the AI provider directly, so the key is briefly in the page's memory and in its network requests. Someone determined, with developer tools open, could extract it. That is true of every browser-only app. The mitigation is fast rotation from the admin panel, not prevention. If you ever need real key secrecy, the fix is a small server-side proxy — the provider layer in `api.js` is the only file that would change.
- **Local data is not encrypted.** Chats and memories sit in `localStorage`. Anyone with developer access to that browser can read them.
- **Anthropic and OpenAI have their own content policies** regardless of what the prompt says. If the spicy mood feels flattened, that is the provider, not the app — DeepSeek, Groq and OpenRouter's uncensored models are the usual answers, and they are all one dropdown away.
- **Supabase's free tier pauses a project after 7 idle days** and takes no automatic backups.
