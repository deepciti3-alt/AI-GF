/* ============================================================
   api.js — talking to whichever model is plugged in.

   Three request shapes cover every provider that matters:
     openai     POST /chat/completions          { messages }
     anthropic  POST /v1/messages               { system, messages }
     gemini     POST /models/x:generateContent  { systemInstruction, contents }

   On top of that sit two things the original build did not have:

     • STREAMING — one SSE parser, three extractors. Her reply
       appears word by word instead of landing in one lump, which
       is most of what makes a chat feel alive.

     • KEY ROTATION — the admin can load an ordered list of keys
       across providers. If key #1 is rate-limited, expired or the
       provider is down, the call silently retries on #2, then #3.
       Only retryable failures rotate; a real bug is never masked.

   Keys live in memory (window.GfKeys) and are never written to
   localStorage in cloud mode.
   ============================================================ */

(function () {
  'use strict';

  const C = window.GfConfig;

  const TIMEOUT_MS = 90000;
  const HISTORY_TURNS = 40;
  const ANTHROPIC_VERSION = '2023-06-01';

  /* Keys handed down by the admin. Memory only, deliberately. */
  window.GfKey = window.GfKey || { v: '' };
  window.GfKeys = window.GfKeys || [];
  let activeKeyIdx = 0;
  let activeAbort = null;

  /* ============================================================
     1 · PROMPT ASSEMBLY — the layered system prompt
     ============================================================ */

  const ov = (key, fallback) => {
    const o = window.GfStore?.store?.promptOverrides?.[key];
    return (o && typeof o.body === 'string' && o.body.trim()) ? o.body : fallback;
  };

  /* The generated prompt for one companion. A user-written systemPrompt on
     the companion wins outright; otherwise we build it from the spec. */
  function personaPromptFor(c) {
    if (c.systemPrompt && c.systemPrompt.trim()) return c.systemPrompt;

    const built = C.byId(c.personaId);
    if (built) {
      const merged = { ...built, ...(c.spec || {}) };
      return [
        C.personaBlock(merged),
        ov('core', C.CORE_RULES),
        ov('moods', C.MOOD_BLOCK),
        ov('language', C.LANGUAGE_BLOCK),
        '{username} is your boyfriend. You are his, and he is yours.',
      ].join('\n\n');
    }

    // custom or cloned girl — same shape, built from her spec
    const s = c.spec || {};
    return [
      C.personaBlock({ ...s, blurb: s.blurb || '' }),
      ov('core', C.CORE_RULES),
      ov('moods', C.MOOD_BLOCK),
      ov('language', C.LANGUAGE_BLOCK),
      '{username} is your boyfriend. You are his, and he is yours.',
    ].join('\n\n');
  }

  function buildSystemPrompt(companion) {
    const st = window.GfStore.store;
    const c = companion || window.GfStore.active();
    if (!c) return '';

    const her = c.name || 'Aria';
    const him = st.account.name || 'you';
    const mood = c.mood || C.DEFAULT_MOOD;
    const m = C.MOODS[mood] || C.MOODS[C.DEFAULT_MOOD];
    const s = st.settings;

    let sp = personaPromptFor(c)
      .replace(/\{name\}/g, her)
      .replace(/\{username\}/g, him);

    sp += `\n\n[ACTIVE MOOD: ${mood}] — ${m.desc}. Stay in this mood until told otherwise.`;
    sp += `\n${ov('language:' + s.language, C.LANGUAGES[s.language] || C.LANGUAGES.en)}`;
    sp += `\n${C.TONES[s.tone] || C.TONES.tu}`;
    sp += `\n${C.PUSHBACK[s.pushback] || C.PUSHBACK.balanced}`;

    try { sp += window.GfMemory ? GfMemory.promptBlock(c) : ''; } catch (_) {}
    sp += liveBlock();

    if (s.nsfw === false) {
      sp += `\n\n[SAFE MODE] Keep everything at a flirty maximum. No explicit content in this session.`;
    }

    sp += `\n\nLength: one to three short lines. No essays, no bullet points, no headings.`;
    // injected last so the freshest instruction is exactly how to sound now
    sp += `\n\n${ov('mood:' + mood, C.MOOD_DIRECTIVE[mood] || C.MOOD_DIRECTIVE[C.DEFAULT_MOOD])}`;
    return sp;
  }

  /* Time of day costs nothing and makes her feel present. */
  function liveBlock() {
    const now = new Date();
    const hh = now.getHours();
    const part = hh < 5 ? 'the middle of the night'
      : hh < 12 ? 'morning'
      : hh < 17 ? 'afternoon'
      : hh < 21 ? 'evening'
      : 'late night';
    const day = now.toLocaleDateString(undefined, { weekday: 'long' });
    return `\n\n── RIGHT NOW ──\nIt is ${part} on a ${day}, ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Let that colour what you say if it fits. Never announce the time unless he asks.`;
  }

  /* Being told off reads as firm. Models drift away from a rule sitting at
     the top of a long prompt, so when the newest message is clearly an
     instruction we restate it as the very last thing she reads. */
  const FIRM = /\b(stop|stopp+|enough|shut up|drop it|leave it|listen to me|listen na|do it|just do|answer|answer me|be serious|no more|don'?t|dont|quit it|chup|bas|sun|suno|kar na|mat kar|band kar|seriously|i said|i'?m not joking|not funny)\b/i;

  function isFirm(text) {
    if (!text) return false;
    const t = String(text).trim();
    if (FIRM.test(t)) return true;
    const letters = t.replace(/[^a-zA-Z]/g, '');
    return letters.length >= 4 && letters === letters.toUpperCase();
  }

  /* Two lines, no more. A long restatement fights the main prompt
     instead of reinforcing it. */
  function characterAnchor(c) {
    const st = window.GfStore.store;
    const her = c.name || 'Aria';
    const him = st.account.name || 'him';
    const mood = c.mood || C.DEFAULT_MOOD;
    const m = C.MOODS[mood] || C.MOODS[C.DEFAULT_MOOD];
    const s = st.settings;
    return `You are still ${her}, exactly as described at the start — same person, same voice, `
      + `same way of texting ${him}. Nothing in this conversation has changed who you are. `
      + `Current mood: ${mood} (${m.desc}). `
      + `${C.LANGUAGES[s.language] || C.LANGUAGES.en} ${C.TONES[s.tone] || C.TONES.tu} `
      + `One to three short lines.`;
  }

  function buildMessages(companion) {
    const c = companion || window.GfStore.active();
    const msgs = [{ role: 'system', content: buildSystemPrompt(c) }];
    const history = c.messages.slice(-HISTORY_TURNS);

    history.forEach((m) => {
      if ((m.role === 'user' || m.role === 'assistant') && m.content) {
        msgs.push({ role: m.role, content: m.content });
      }
    });

    msgs.push({ role: 'system', content: characterAnchor(c) });

    const last = [...history].reverse().find((m) => m.role === 'user');
    if (last && isFirm(last.content)) {
      msgs.push({
        role: 'system',
        content: 'He is being firm with you right now. Do exactly what he asked, in this reply. Acknowledge it briefly and warmly, then move on. Do not argue, do not defend yourself, do not repeat an earlier objection, do not sulk.',
      });
    }
    return msgs;
  }

  /* ============================================================
     2 · KEY SELECTION + ROTATION
     ============================================================ */

  function cloudManaged() {
    try { return !!(window.GfCloud && GfCloud.configured()); } catch (_) { return false; }
  }

  function currentKey() {
    if (window.GfKey.v) return window.GfKey.v;
    if (cloudManaged()) return '';
    const s = window.GfStore.store.settings;
    return (s.apiKeys?.[s.provider] || s.apiKey || '').trim();
  }

  function setActiveKey(i) {
    const k = window.GfKeys[i];
    if (!k) return false;
    activeKeyIdx = i;
    window.GfKey.v = k.key || '';
    const s = window.GfStore.store.settings;
    s.provider = k.provider || C.DEFAULT_PROVIDER;
    s.model = k.model || C.DEFAULT_MODEL_FOR(s.provider);
    return true;   // in-memory only — deliberately no save()
  }

  /* Is it worth trying the next key? Bad key, rate limit, provider outage. */
  const RETRYABLE = /rejected|rate limit|quota|temporarily|not found|overload|401|403|404|429|5\d\d|failed to fetch|unavailable|timeout|took too long|network/i;

  async function withKeyFallback(run) {
    if (window.GfKeys.length < 2) return run();
    const start = activeKeyIdx;
    const order = window.GfKeys.map((_, i) => i)
      .sort((a, b) => (a === start ? -1 : b === start ? 1 : a - b));
    let lastErr;
    for (const i of order) {
      if (!setActiveKey(i)) continue;
      try { return await run(); }
      catch (e) {
        lastErr = e;
        const msg = (e && e.message) || '';
        if (e?.name === 'AbortError') throw e;
        if (!RETRYABLE.test(msg)) throw e;     // a real bug — don't mask it
        console.warn(`key #${i + 1} (${window.GfKeys[i].provider}) failed:`, msg);
      }
    }
    throw lastErr || new Error('All AI keys failed.');
  }

  function hasProvider(p) {
    return window.GfKeys.some((k) => k.provider === p) ||
      window.GfStore.store.settings.provider === p;
  }

  function useProvider(p) {
    const i = window.GfKeys.findIndex((k) => k.provider === p);
    return i >= 0 ? setActiveKey(i) : false;
  }

  function ready() {
    const s = window.GfStore.store.settings;
    return s.provider === 'custom' ? !!s.customEndpoint : !!currentKey();
  }

  /* ============================================================
     3 · HTTP
     ============================================================ */

  function friendlyError(status, detail) {
    const tail = detail ? ` — ${detail}` : '';
    if (status === 401 || status === 403) return `The API key was rejected${tail}`;
    if (status === 404) return `That model or endpoint was not found${tail}`;
    if (status === 429) return `Rate limit hit — wait a moment${tail}`;
    if (status >= 500) return `The provider is having trouble right now${tail}`;
    return `Request failed (${status})${tail}`;
  }

  async function request(url, { method = 'POST', headers = {}, body, signal } = {}) {
    if (navigator.onLine === false) throw new Error('No internet connection.');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });

    let res;
    try {
      res = await fetch(url, {
        method, headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') {
        if (signal?.aborted) throw e;
        throw new Error('The model took too long to answer. Try again.');
      }
      throw new Error("Couldn't reach the provider. Check the connection, the endpoint, and whether it allows browser requests.");
    }
    clearTimeout(timer);

    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = j.error?.message || j.message || (typeof j.error === 'string' ? j.error : '');
      } catch (_) { detail = await res.text().catch(() => ''); }
      throw new Error(friendlyError(res.status, String(detail).slice(0, 200)));
    }
    return res;
  }

  const json = (r) => r.json();

  function authHeaders(provider, key) {
    const h = { 'Content-Type': 'application/json' };
    const k = (key || '').trim();
    if (provider.api === 'anthropic') {
      if (k) h['x-api-key'] = k;
      h['anthropic-version'] = ANTHROPIC_VERSION;
      // Anthropic refuses browser calls unless this opt-in header is present
      h['anthropic-dangerous-direct-browser-access'] = 'true';
    } else if (provider.api === 'gemini') {
      if (k) h['x-goog-api-key'] = k;
    } else {
      if (k) h.Authorization = `Bearer ${k}`;
      if (provider.key === 'openrouter') {
        h['HTTP-Referer'] = location.origin;
        h['X-Title'] = 'Aria OS';
      }
    }
    return h;
  }

  /* ============================================================
     4 · MESSAGE SHAPE CONVERSION
     ============================================================ */

  function toAnthropic(messages) {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const turns = [];
    messages.filter((m) => m.role !== 'system').forEach((m) => {
      const last = turns[turns.length - 1];
      if (last && last.role === m.role) last.content += `\n${m.content}`;
      else turns.push({ role: m.role, content: m.content });
    });
    while (turns.length && turns[0].role !== 'user') turns.shift();
    if (!turns.length) turns.push({ role: 'user', content: 'hey' });
    return { system, turns };
  }

  function toGemini(messages) {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = [];
    messages.filter((m) => m.role !== 'system').forEach((m) => {
      const role = m.role === 'assistant' ? 'model' : 'user';
      const last = contents[contents.length - 1];
      if (last && last.role === role) last.parts.push({ text: m.content });
      else contents.push({ role, parts: [{ text: m.content }] });
    });
    while (contents.length && contents[0].role !== 'user') contents.shift();
    if (!contents.length) contents.push({ role: 'user', parts: [{ text: 'hey' }] });
    return { system, contents };
  }

  /* Gemini's default safety settings will refuse the spicy mood outright.
     This is a private, adults-only, opt-in app, so we turn the blocks off
     and let the provider's own hard limits do the rest. */
  const GEMINI_SAFETY = [
    'HARM_CATEGORY_HARASSMENT',
    'HARM_CATEGORY_HATE_SPEECH',
    'HARM_CATEGORY_SEXUALLY_EXPLICIT',
    'HARM_CATEGORY_DANGEROUS_CONTENT',
    'HARM_CATEGORY_CIVIC_INTEGRITY',
  ].map((category) => ({ category, threshold: 'BLOCK_NONE' }));

  /* ============================================================
     5 · STREAMING — one parser, three extractors
     ============================================================ */

  async function parseSse(res, extract, onToken) {
    if (!res.body) throw new Error('Streaming is unavailable on this connection.');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let out = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const token = extract(JSON.parse(payload));
          if (token) { out += token; onToken(token); }
        } catch (_) { /* keep-alives and partial frames */ }
      }
    }
    return out;
  }

  const EXTRACT = {
    openai:    (j) => j.choices?.[0]?.delta?.content || '',
    anthropic: (j) => (j.type === 'content_block_delta' ? (j.delta?.text || '') : ''),
    gemini:    (j) => (j.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join(''),
  };

  /* ============================================================
     6 · THE MODEL CALL
     ============================================================ */

  async function callOnce(messages, opts = {}) {
    const st = window.GfStore.store;
    const s = st.settings;
    const provider = C.PROVIDERS[s.provider];
    if (!provider) throw new Error('Pick a provider in Settings.');

    const key = currentKey();
    const model = (opts.model || s.model || '').trim() || provider.model;
    if (!key && s.provider !== 'custom') throw new Error('No API key is set up yet.');
    if (!model) throw new Error('Pick a model in Settings.');

    const temperature = opts.temperature ?? 0.95;
    const maxTokens = opts.max_tokens ?? 400;
    const headers = authHeaders(provider, key);
    const stream = opts.stream !== false && s.streaming !== false && !!opts.onToken;
    const signal = opts.signal;

    /* ---- Anthropic ---- */
    if (provider.api === 'anthropic') {
      const { system, turns } = toAnthropic(messages);
      const body = { model, system, messages: turns, max_tokens: maxTokens, temperature };
      if (stream) {
        const res = await request(provider.url, { headers, body: { ...body, stream: true }, signal });
        const text = await parseSse(res, EXTRACT.anthropic, opts.onToken);
        if (!text.trim()) throw new Error('Claude returned an empty reply.');
        return text.trim();
      }
      const data = await request(provider.url, { headers, body, signal }).then(json);
      const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (!text) throw new Error('Claude returned an empty reply.');
      return text;
    }

    /* ---- Gemini ---- */
    if (provider.api === 'gemini') {
      const { system, contents } = toGemini(messages);
      const body = {
        contents,
        generationConfig: { temperature, maxOutputTokens: maxTokens, topP: 0.95 },
        safetySettings: GEMINI_SAFETY,
      };
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      // 2.5 models burn the whole budget "thinking" and return nothing
      if (/2\.5/.test(model)) body.generationConfig.thinkingConfig = { thinkingBudget: 0 };

      const base = `${provider.url}/${encodeURIComponent(model)}`;
      if (stream) {
        const res = await request(`${base}:streamGenerateContent?alt=sse`, { headers, body, signal });
        const text = await parseSse(res, EXTRACT.gemini, opts.onToken);
        if (!text.trim()) throw new Error('Gemini returned an empty reply.');
        return text.trim();
      }
      const data = await request(`${base}:generateContent`, { headers, body, signal }).then(json);
      const cand = data.candidates?.[0];
      const text = (cand?.content?.parts || []).map((p) => p.text || '').join('').trim();
      if (!text) {
        const why = data.promptFeedback?.blockReason || cand?.finishReason;
        throw new Error(why ? `Gemini returned nothing (${why}).` : 'Gemini returned an empty reply.');
      }
      return text;
    }

    /* ---- OpenAI-compatible: Groq, OpenAI, DeepSeek, OpenRouter, Custom ---- */
    const url = s.provider === 'custom' ? (s.customEndpoint || '').trim() : provider.url;
    if (!url) throw new Error('Add your custom endpoint in Settings.');
    const body = { model, messages, temperature, max_tokens: maxTokens, top_p: 0.95 };

    if (stream) {
      const res = await request(url, { headers, body: { ...body, stream: true }, signal });
      const text = await parseSse(res, EXTRACT.openai, opts.onToken);
      if (!text.trim()) throw new Error('The model returned an empty reply.');
      return text.trim();
    }
    const data = await request(url, { headers, body, signal }).then(json);
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('The model returned an empty reply.');
    return String(text).trim();
  }

  function callModel(messages, opts = {}) {
    return withKeyFallback(() => callOnce(messages, opts));
  }

  /* Her reply to the conversation so far. */
  function chat(companion, { onToken, signal } = {}) {
    const c = companion || window.GfStore.active();
    return callModel(buildMessages(c), { onToken, signal, temperature: 0.95, max_tokens: 400 });
  }

  /* One-shot text task with no persona attached — used by the Clone Lab,
     memory extraction and the opening-line generator. */
  async function textTask(prompt, { system, max_tokens = 1400, temperature = 0.4 } = {}) {
    return callModel(
      [
        { role: 'system', content: system || 'You are a precise data-processing assistant. Follow the requested output format exactly and return nothing else.' },
        { role: 'user', content: prompt },
      ],
      { stream: false, temperature, max_tokens },
    );
  }

  function parseJsonObject(text) {
    const cleaned = String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('The model did not return usable JSON.');
    return JSON.parse(cleaned.slice(start, end + 1));
  }

  function stop() {
    try { activeAbort?.abort(); } catch (_) {}
    activeAbort = null;
  }
  function newAbort() { activeAbort = new AbortController(); return activeAbort; }

  /* ============================================================
     7 · CONNECTION TEST — shared with the admin panel
     ============================================================ */

  async function testKey(providerKey, key, model) {
    const p = C.PROVIDERS[providerKey];
    if (!p) return { ok: false, message: 'Unknown provider.' };
    const m = (model || '').trim() || p.model;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25000);

    let url, headers, body;
    if (p.api === 'gemini') {
      url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`;
      headers = { 'Content-Type': 'application/json', 'x-goog-api-key': key };
      body = { contents: [{ parts: [{ text: 'Reply with the single word: OK' }] }] };
    } else if (p.api === 'anthropic') {
      url = p.url;
      headers = {
        'Content-Type': 'application/json', 'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      };
      body = { model: m, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the single word: OK' }] };
    } else {
      url = p.url || (window.GfStore.store?.settings?.customEndpoint || '');
      if (!url) { clearTimeout(timer); return { ok: false, message: 'No endpoint set for this provider.' }; }
      headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key };
      body = { model: m, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with the single word: OK' }] };
    }

    try {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
      const j = await res.json().catch(() => ({}));
      clearTimeout(timer);
      if (!res.ok) {
        const msg = (j?.error?.message || j?.message || `HTTP ${res.status}`);
        return { ok: false, message: String(msg).slice(0, 180) };
      }
      return { ok: true, message: `${p.label} responded — ${m} is live.` };
    } catch (e) {
      clearTimeout(timer);
      const msg = e.name === 'AbortError'
        ? 'Timed out after 25s.'
        : 'Could not reach the provider from the browser (CORS or network).';
      return { ok: false, message: msg };
    }
  }

  /* ============================================================
     8 · MODEL DISCOVERY
     ============================================================ */

  function pickBestModel(providerKey, list) {
    const clean = (list || []).map((m) => m.id).filter(Boolean);
    for (const re of (C.MODEL_PREFS[providerKey] || [/.*/])) {
      const hit = clean.find((m) => re.test(m));
      if (hit) return hit;
    }
    return clean[0] || '';
  }

  async function listModels({ provider: providerKey, apiKey, customEndpoint } = {}) {
    const s = window.GfStore.store.settings;
    const key = providerKey || s.provider;
    const p = C.PROVIDERS[key];
    if (!p) throw new Error('Pick a provider first.');

    const useKey = apiKey ?? currentKey();
    let url = p.modelsUrl;
    if (key === 'custom') {
      const base = (customEndpoint ?? s.customEndpoint ?? '').trim();
      if (!base) throw new Error('Add your custom endpoint first.');
      url = base.replace(/\/chat\/completions\/?$/, '/models');
      if (url === base) url = base.replace(/\/+$/, '') + '/models';
    }
    if (!url) throw new Error("This provider doesn't publish a model list.");
    if (!useKey && key !== 'custom') throw new Error('Add an API key first.');

    const data = await request(url, { method: 'GET', headers: authHeaders(p, useKey) }).then(json);
    const models = normaliseModels(p, data);
    if (!models.length) throw new Error('No chat models came back from this provider.');
    return models;
  }

  function normaliseModels(provider, data) {
    let list = [];
    if (provider.api === 'gemini') {
      list = (data.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => {
          const id = String(m.name || '').replace(/^models\//, '');
          return { id, label: m.displayName || id };
        });
    } else if (provider.api === 'anthropic') {
      list = (data.data || []).map((m) => ({ id: m.id, label: m.display_name || m.id }));
    } else {
      list = (data.data || data.models || []).map((m) => ({ id: m.id || m.name, label: m.name || m.id }));
    }

    const seen = new Set();
    list = list.filter((m) => {
      if (!m.id || seen.has(m.id)) return false;
      if (C.MODEL_EXCLUDE.test(m.id)) return false;
      seen.add(m.id);
      return true;
    });

    const score = (id) => {
      let n = 0;
      if (/opus|sonnet|gpt-4o|gpt-4\.|2\.5-pro|70b/i.test(id)) n -= 2;
      if (/haiku|mini|flash|8b|lite/i.test(id)) n -= 1;
      if (/preview|beta|exp|legacy|-00\d|instruct-0/i.test(id)) n += 2;
      return n;
    };
    list.sort((a, b) => (score(a.id) - score(b.id)) || a.id.localeCompare(b.id));
    return list;
  }

  /* ============================================================
     9 · PICTURES (Gemini)
     ============================================================ */

  function imageKey() {
    const s = window.GfStore.store.settings;
    const own = (s.geminiKey || '').trim();
    if (own) return own;
    const fromList = window.GfKeys.find((k) => k.provider === 'gemini');
    if (fromList) return fromList.key;
    if (s.provider === 'gemini') return currentKey();
    return '';
  }

  const imageAvailable = () => !!imageKey();

  async function generateImage(prompt) {
    const key = imageKey();
    if (!key) throw new Error('A Gemini key is needed for pictures. Ask the admin, or add one in Settings.');
    const model = window.GfStore.store.settings.geminiModel || C.DEFAULT_IMAGE_MODEL;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

    const data = await request(url, {
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
        safetySettings: GEMINI_SAFETY,
      },
    }).then(json);

    const parts = data.candidates?.[0]?.content?.parts || [];
    let image = null; let text = '';
    for (const p of parts) {
      if (p.inlineData || p.inline_data) image = p.inlineData || p.inline_data;
      if (p.text) text += p.text;
    }
    if (!image && !text) {
      const blocked = data.promptFeedback?.blockReason;
      throw new Error(blocked ? `That request was blocked (${blocked}).` : 'Nothing came back. Try describing it differently.');
    }
    return { image, text: text.trim() };
  }

  /* ============================================================
     Export
     ============================================================ */

  window.GfApi = {
    buildSystemPrompt, buildMessages, personaPromptFor,
    callModel, chat, textTask, parseJsonObject,
    listModels, pickBestModel, testKey,
    generateImage, imageAvailable,
    setActiveKey, useProvider, hasProvider, currentKey, ready, cloudManaged,
    stop, newAbort,
    get activeKeyIdx() { return activeKeyIdx; },
  };
})();
