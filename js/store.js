/* ============================================================
   store.js — every byte of state, and where it lives.

   Two storage buckets per account:
     ariaos_v1.<email>          the whole store (chats, memory, settings)
     ariaos_v1.<email>.media    generated pictures, base64

   Pictures live apart on purpose. The main blob is rewritten on
   every single message, and stringifying a few megabytes of image
   data on each one is the single biggest cause of a phone feeling
   like it has stalled.

   The API key is NEVER written to either bucket when the app is
   running in cloud mode — it lives in memory only, handed down by
   the admin at runtime. See admin.js applyConfig().
   ============================================================ */

(function () {
  'use strict';

  const C = window.GfConfig;
  const PREFIX = C.STORE_PREFIX;

  const bucketFor = (email) =>
    PREFIX + '.' + String(email || 'local').toLowerCase().replace(/[^a-z0-9@._-]/g, '');
  const mediaBucketFor = (email) => bucketFor(email) + '.media';

  const MAX_MESSAGES = 500;   // per companion
  const MAX_IMAGES   = 24;    // per account
  const SAVE_DELAY   = 450;

  const uid = (p = 'id') =>
    `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

  /* ============================================================
     Defaults
     ============================================================ */

  function freshMemory() {
    return { facts: [], moments: [], summary: '', lastExtractedCount: 0 };
  }

  /* Turn a built-in personality into a live companion record. */
  function companionFromPersonality(p, userName) {
    return {
      id: p.id,
      personaId: p.id,
      family: p.family,
      name: p.defaultName,
      emoji: p.emoji,
      avatarImg: '',                     // drop a file into assets/avatars/ and point here
      custom: false,
      spec: {
        label: p.label, blurb: p.blurb, age: p.age,
        tradition: p.tradition, register: p.register, rhythm: p.rhythm,
        opens_with: p.opens_with, moves: p.moves, lexicon: p.lexicon,
        refuses: p.refuses, closes_with: p.closes_with, spice: p.spice, tell: p.tell,
      },
      systemPrompt: '',                  // empty = use the generated one; set = user override
      mood: C.DEFAULT_MOOD,
      messages: [],
      memory: freshMemory(),
      unread: 0,
      pinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      clonedFrom: null,
    };
  }

  function defaultCompanions(userName) {
    const out = {};
    const order = [];
    C.PERSONALITIES.forEach((p) => {
      out[p.id] = companionFromPersonality(p, userName);
      order.push(p.id);
    });
    return { companions: out, order };
  }

  function defaults(email, name) {
    const { companions, order } = defaultCompanions(name);
    return {
      version: 1,
      account: { email: email || '', name: name || '', cloud: false },
      settings: {
        provider: C.DEFAULT_PROVIDER,
        model: C.DEFAULT_MODEL_FOR(C.DEFAULT_PROVIDER),
        customEndpoint: '',
        apiKey: '',            // only used in the no-cloud build
        apiKeys: {},           // one remembered key per provider, no-cloud build only
        geminiKey: '',
        geminiModel: C.DEFAULT_IMAGE_MODEL,
        language: 'en',
        tone: 'tu',
        pushback: 'balanced',
        autoMemory: true,
        autoSpeak: false,
        streaming: true,
        voiceLang: 'en-IN',
        ttsLang: 'en',
        theme: 'light',
        skin: 'brand',
        nsfw: true,
        typingDelay: true,
        _adminCfgAt: '',
        _models: {},
      },
      activeId: C.PERSONALITIES[0].id,
      companions,
      order,
      clones: [],
      promptOverrides: {},     // { 'core': {body}, 'mood:spicy': {body}, ... }
      hidden: [],              // soft-deleted built-in personality ids
      gallery: [],             // {id, prompt, mime, at}  — bytes live in the media bucket
      lastSeenAt: Date.now(),
    };
  }

  /* ============================================================
     Live state
     ============================================================ */

  const S = {
    store: null,
    media: {},
    bucket: null,
    mediaBucket: null,
    ready: false,
  };

  let saveTimer = null;

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) { return fallback; }
  }

  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) {
      // quota — drop the oldest pictures and try once more
      try {
        if (S.mediaBucket && Object.keys(S.media).length) {
          const keys = Object.keys(S.media).slice(0, 6);
          keys.forEach((k) => delete S.media[k]);
          localStorage.setItem(S.mediaBucket, JSON.stringify(S.media));
          localStorage.setItem(key, JSON.stringify(value));
          return true;
        }
      } catch (_) {}
      console.warn('Could not save', e);
      return false;
    }
  }

  /* Additive, forward-only migration: fill anything missing from defaults,
     and heal any built-in companion the user's blob predates. */
  function migrate(raw, email, name) {
    const base = defaults(email, name);
    if (!raw || typeof raw !== 'object') return base;

    const out = { ...base, ...raw };
    out.settings   = { ...base.settings, ...(raw.settings || {}) };
    out.account    = { ...base.account, ...(raw.account || {}) };
    out.companions = { ...(raw.companions || {}) };
    out.order      = Array.isArray(raw.order) ? raw.order.slice() : [];
    out.clones     = Array.isArray(raw.clones) ? raw.clones : [];
    out.gallery    = Array.isArray(raw.gallery) ? raw.gallery : [];
    out.hidden     = Array.isArray(raw.hidden) ? raw.hidden : [];
    out.promptOverrides = raw.promptOverrides || {};

    // add any built-in personality that did not exist when this blob was written
    C.PERSONALITIES.forEach((p) => {
      if (!out.companions[p.id]) {
        out.companions[p.id] = companionFromPersonality(p, out.account.name);
      } else {
        const c = out.companions[p.id];
        c.spec   = { ...companionFromPersonality(p).spec, ...(c.spec || {}) };
        c.memory = { ...freshMemory(), ...(c.memory || {}) };
        c.messages = Array.isArray(c.messages) ? c.messages : [];
        c.family = c.family || p.family;
        c.emoji = c.emoji || p.emoji;
      }
      if (!out.order.includes(p.id)) out.order.push(p.id);
    });

    // heal custom/cloned companions
    Object.values(out.companions).forEach((c) => {
      c.memory = { ...freshMemory(), ...(c.memory || {}) };
      c.messages = Array.isArray(c.messages) ? c.messages : [];
      if (!out.order.includes(c.id)) out.order.push(c.id);
    });

    // drop order entries pointing at nothing
    out.order = out.order.filter((id) => out.companions[id]);

    if (!out.companions[out.activeId]) out.activeId = out.order[0];
    out.version = 1;
    return out;
  }

  /* ============================================================
     Public API
     ============================================================ */

  /* Open (or create) the bucket for this account. Two people sharing a
     device must never see each other's chats, so a bucket is only reused
     when the email provably matches. */
  function open(email, name) {
    const bucket = bucketFor(email);
    S.bucket = bucket;
    S.mediaBucket = mediaBucketFor(email);

    const raw = readJSON(bucket, null);
    const ownedByThisEmail =
      !email || !raw || !raw.account?.email ||
      String(raw.account.email).toLowerCase() === String(email).toLowerCase();

    S.store = migrate(ownedByThisEmail ? raw : null, email, name);
    S.store.account.email = email || S.store.account.email || '';
    if (name) S.store.account.name = name;
    S.store.lastSeenAt = Date.now();

    S.media = readJSON(S.mediaBucket, {}) || {};
    S.ready = true;
    applyChrome();
    return S.store;
  }

  function applyChrome() {
    const s = S.store?.settings;
    if (!s) return;
    document.documentElement.dataset.theme = s.theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.skin = s.skin === 'aurora' ? 'aurora' : 'brand';
  }

  function saveNow() {
    if (!S.ready || !S.bucket) return false;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    trim();
    const ok = writeJSON(S.bucket, S.store);
    try { window.GfCloud && GfCloud.pushDebounced(S.store); } catch (_) {}
    return ok;
  }

  function save() {
    if (!S.ready) return false;
    if (saveTimer) return true;
    saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, SAVE_DELAY);
    return true;
  }

  function trim() {
    const st = S.store;
    if (!st) return;
    Object.values(st.companions).forEach((c) => {
      if (c.messages.length > MAX_MESSAGES) {
        c.messages = c.messages.slice(-MAX_MESSAGES);
      }
    });
    if (st.gallery.length > MAX_IMAGES) {
      const dropped = st.gallery.slice(0, st.gallery.length - MAX_IMAGES);
      dropped.forEach((g) => { delete S.media[g.id]; });
      st.gallery = st.gallery.slice(-MAX_IMAGES);
      writeJSON(S.mediaBucket, S.media);
    }
  }

  /* ---------- companions ---------- */

  function list() {
    const st = S.store;
    if (!st) return [];
    const hidden = new Set(st.hidden || []);
    return st.order
      .map((id) => st.companions[id])
      .filter(Boolean)
      .filter((c) => c.custom || !hidden.has(c.id));
  }

  function active() {
    const st = S.store;
    if (!st) return null;
    return st.companions[st.activeId] || list()[0] || null;
  }

  function setActive(id) {
    if (!S.store || !S.store.companions[id]) return false;
    S.store.activeId = id;
    S.store.companions[id].unread = 0;
    saveNow();
    return true;
  }

  /* Create a companion from an arbitrary spec — used by the Clone Lab and
     by "make your own" in the Companions page. */
  function createCompanion({ name, emoji, family, spec, systemPrompt, clonedFrom, avatarImg }) {
    const st = S.store;
    const id = uid('gf');
    st.companions[id] = {
      id,
      personaId: null,
      family: family || 'romance',
      name: String(name || 'Her').slice(0, 40),
      emoji: emoji || '💜',
      avatarImg: avatarImg || '',
      custom: true,
      spec: spec || {},
      systemPrompt: systemPrompt || '',
      mood: C.DEFAULT_MOOD,
      messages: [],
      memory: freshMemory(),
      unread: 0,
      pinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      clonedFrom: clonedFrom || null,
    };
    st.order.unshift(id);
    saveNow();
    return st.companions[id];
  }

  function updateCompanion(id, patch) {
    const c = S.store?.companions[id];
    if (!c) return null;
    Object.assign(c, patch, { updatedAt: Date.now() });
    saveNow();
    return c;
  }

  /* Custom girls are deleted for real. Built-ins are hidden, so the user can
     always get them back — nothing they did not create is ever destroyed. */
  function removeCompanion(id) {
    const st = S.store;
    const c = st?.companions[id];
    if (!c) return false;
    if (c.custom) {
      delete st.companions[id];
      st.order = st.order.filter((x) => x !== id);
      st.clones = st.clones.filter((cl) => cl.companionId !== id);
    } else if (!st.hidden.includes(id)) {
      st.hidden.push(id);
    }
    if (st.activeId === id) st.activeId = (list()[0] || {}).id || null;
    saveNow();
    return true;
  }

  function restoreCompanion(id) {
    if (!S.store) return;
    S.store.hidden = S.store.hidden.filter((x) => x !== id);
    saveNow();
  }

  function resetChat(id) {
    const c = S.store?.companions[id];
    if (!c) return;
    c.messages = [];
    saveNow();
  }

  /* ---------- messages ---------- */

  function pushMessage(companionId, role, content, extra) {
    const c = S.store?.companions[companionId];
    if (!c) return null;
    const m = {
      id: uid('m'),
      role,
      content: String(content || ''),
      at: Date.now(),
      ...(extra || {}),
    };
    c.messages.push(m);
    c.updatedAt = Date.now();
    save();
    return m;
  }

  function removeMessage(companionId, messageId) {
    const c = S.store?.companions[companionId];
    if (!c) return;
    c.messages = c.messages.filter((m) => m.id !== messageId);
    save();
  }

  /* ---------- pictures ---------- */

  function putImage(prompt, mime, b64) {
    const st = S.store;
    const id = uid('img');
    S.media[id] = { mime: mime || 'image/png', b64 };
    st.gallery.push({ id, prompt: String(prompt || '').slice(0, 300), mime, at: Date.now() });
    writeJSON(S.mediaBucket, S.media);
    saveNow();
    return id;
  }

  function getImage(id) { return S.media[id] || null; }

  function removeImage(id) {
    delete S.media[id];
    S.store.gallery = S.store.gallery.filter((g) => g.id !== id);
    writeJSON(S.mediaBucket, S.media);
    saveNow();
  }

  /* ---------- export / import / wipe ---------- */

  function exportAll(includeKeys) {
    const clone = JSON.parse(JSON.stringify(S.store));
    if (!includeKeys) {
      clone.settings.apiKey = '';
      clone.settings.apiKeys = {};
      clone.settings.geminiKey = '';
    }
    return {
      product: 'Aria OS',
      exportVersion: 1,
      exportedAt: new Date().toISOString(),
      includesKeys: !!includeKeys,
      data: clone,
      media: S.media,
    };
  }

  function importAll(payload) {
    if (!payload || payload.product !== 'Aria OS') {
      throw new Error('That is not an Aria OS backup file.');
    }
    const email = S.store?.account?.email || '';
    S.store = migrate(payload.data, email, payload.data?.account?.name);
    S.store.account.email = email;
    if (payload.media && typeof payload.media === 'object') S.media = payload.media;
    writeJSON(S.mediaBucket, S.media);
    saveNow();
    applyChrome();
    return S.store;
  }

  function wipe() {
    try { localStorage.removeItem(S.bucket); } catch (_) {}
    try { localStorage.removeItem(S.mediaBucket); } catch (_) {}
    S.media = {};
    S.store = defaults(S.store?.account?.email, S.store?.account?.name);
    saveNow();
  }

  /* ============================================================
     Export
     ============================================================ */

  window.GfStore = {
    get store() { return S.store; },
    get media() { return S.media; },
    get ready() { return S.ready; },

    uid, freshMemory, companionFromPersonality, defaults,
    open, save, saveNow, applyChrome, trim,

    list, active, setActive,
    createCompanion, updateCompanion, removeCompanion, restoreCompanion, resetChat,
    pushMessage, removeMessage,
    putImage, getImage, removeImage,
    exportAll, importAll, wipe,
  };

  /* Convenience globals, mirroring the NutriWeb style the admin panel expects. */
  Object.defineProperty(window, 'store', { get() { return S.store; }, configurable: true });
  window.save = save;
})();
