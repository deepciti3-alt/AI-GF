/* ============================================================
   local.js — a zero-setup backend that lives in the browser.
   window.GfLocal

   WHY THIS EXISTS
   ------------------------------------------------------------
   The whole app — mobile-number login, the admin panel, coupons,
   the shared multi-API key list — was written to run on Supabase.
   That is the right choice for a real deployment with many users on
   many devices. But it needs a Supabase project, a SQL run and two
   pasted keys before ANYTHING turns on. Until then js/supabase.js is
   blank, GfCloud.configured() is false, and the app opens straight
   into local-only mode: no login screen, no gate, no admin panel.
   That is the "there is no admin panel, it just opens the app" bug.

   GfLocal fixes that WITHOUT any setup. It implements the exact same
   surface the UI already talks to —

       auth:  signInPhone / signUpPhone / signOut / updatePassword /
              createAccountDetached / currentUser
       data:  rpc(fn, args)      (gf_bootstrap, gf_get_config, …)
              table(name)        (gf_config, gf_coupons, gf_personas)

   — but backed by localStorage instead of Postgres. supabase.js
   simply routes to GfLocal whenever real Supabase keys are absent.
   The result: open the domain and you get a real login screen; the
   admin signs in and gets the real admin panel; everyone else signs
   up with a number and a password and shares the keys the admin
   loads. All offline, all on one device.

   HONEST LIMITATION (same as the rest of a browser-only app)
   ------------------------------------------------------------
   Everything here is on the device. The gate is fail-open on the
   client by design, and localStorage is readable by anyone at the
   keyboard. Passwords are stored only as a non-reversible hash, but
   this is device-local security, not server security. The moment you
   fill in real Supabase keys in js/supabase.js, the app switches to
   the real server backend and this file goes dormant automatically.
   ============================================================ */

(function () {
  'use strict';

  /* The admin identity. admin.js also sets window.GF_ADMIN; whichever
     runs first wins (both use ||). We seed it here so the local backend
     can create the admin account before admin.js has even loaded. */
  window.GF_ADMIN = window.GF_ADMIN || {
    phone: '9873393559',   // sign in with this number …
    pass:  '987339',       // … and this password to reach the admin panel
    name:  'Admin',
  };

  const NS = 'ariaos_local_v1';         // the single localStorage key we own
  const PHONE_DOMAIN = 'ariaos.app';
  const TRIAL_DEFAULT = 7;

  let onAuthChange = null;

  /* ---------- tiny helpers ---------- */

  const nowISO = () => new Date().toISOString();

  const uid = (p = 'u') =>
    `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

  /* A small, non-reversible hash. Not cryptographic — it just keeps
     plain passwords out of localStorage so a casual look does not leak
     them. Device-local security only. */
  function hash(str) {
    let h = 5381;
    const s = 'aria:' + String(str == null ? '' : str);
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return 'h' + h.toString(36);
  }

  function normalisePhone(input) {
    let d = String(input || '').replace(/\D/g, '');
    if (d.length > 10 && d.startsWith('91')) d = d.slice(2);
    if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    return d;
  }
  const validPhone = (p) => { const d = normalisePhone(p); return d.length >= 10 && d.length <= 15; };
  const phoneToEmail = (p) => `${normalisePhone(p)}@${PHONE_DOMAIN}`;

  const adminPhone = () => normalisePhone((window.GF_ADMIN && window.GF_ADMIN.phone) || '');
  const isAdminPhone = (p) => !!adminPhone() && normalisePhone(p) === adminPhone();

  /* ---------- the store ---------- */

  function blank() {
    return {
      users: {},        // user_id -> profile row (+ pass hash)
      session: null,    // user_id of whoever is signed in on this device
      coupons: [],      // {code, days, max_uses, used_count, active, note, created_at}
      couponUses: [],   // {code, user_id}
      config: {
        id: 1,
        provider: 'gemini',
        api_key: '',           // raw key OR the {"v":1,"keys":[...]} envelope
        model: '',
        trial_days: TRIAL_DEFAULT,
        announcement: '',
        nsfw_enabled: true,
        updated_at: nowISO(),
      },
      personas: [],     // published personalities
      states: {},       // user_id -> {updated_at, has_data}
    };
  }

  function read() {
    try {
      const raw = localStorage.getItem(NS);
      if (!raw) return null;
      const db = JSON.parse(raw);
      return db && typeof db === 'object' ? db : null;
    } catch (_) { return null; }
  }

  function write(db) {
    try { localStorage.setItem(NS, JSON.stringify(db)); return true; }
    catch (e) { console.warn('GfLocal save failed', e); return false; }
  }

  let DB = null;

  /* Load, healing anything a previous version left missing, and make sure
     the admin account and the config row always exist. */
  function load() {
    DB = read() || blank();
    const base = blank();
    for (const k of Object.keys(base)) if (DB[k] == null) DB[k] = base[k];
    DB.config = { ...base.config, ...(DB.config || {}) };
    seedAdmin();
    return DB;
  }

  function seedAdmin() {
    const email = phoneToEmail(adminPhone());
    const existing = Object.values(DB.users).find((u) => u.email === email);
    if (existing) return existing;
    const id = 'admin_' + normalisePhone(adminPhone());
    DB.users[id] = {
      user_id: id,
      email,
      phone: adminPhone(),
      name: (window.GF_ADMIN && window.GF_ADMIN.name) || 'Admin',
      pass: hash((window.GF_ADMIN && window.GF_ADMIN.pass) || '987339'),
      status: 'active',
      trial_ends_at: nowISO(),
      access_until: null,          // null + active = lifetime
      coupon_used: null,
      note: 'Administrator',
      created_at: nowISO(),
      last_seen_at: nowISO(),
    };
    write(DB);
    return DB.users[id];
  }

  const save = () => write(DB);
  const sessionUser = () => (DB && DB.session && DB.users[DB.session]) || null;
  const findByPhone = (p) => Object.values(DB.users).find((u) => u.email === phoneToEmail(p)) || null;

  /* Mirror of the SQL gf_has_access() predicate, to the letter. */
  function hasAccess(u) {
    if (!u) return false;
    if (isAdminPhone(u.phone)) return true;
    if (u.status === 'blocked') return false;
    if (u.status === 'active' && !u.access_until) return true;
    if (u.access_until && Date.parse(u.access_until) > Date.now()) return true;
    if (u.trial_ends_at && Date.parse(u.trial_ends_at) > Date.now()) return true;
    return false;
  }

  /* The public shape currentUser() returns, matching a Supabase auth user
     closely enough for app.js (user.email, user.user_metadata.name/phone). */
  function publicUser(u) {
    if (!u) return null;
    return { id: u.user_id, email: u.email, user_metadata: { name: u.name || '', phone: u.phone || '' } };
  }

  /* ============================================================
     AUTH
     ============================================================ */

  function init(authCb) {
    onAuthChange = authCb || null;
    load();
    return { enabled: true, user: publicUser(sessionUser()) };
  }

  function currentUser() { return publicUser(sessionUser()); }

  function fireAuth() { try { if (onAuthChange) onAuthChange(currentUser()); } catch (_) {} }

  async function signInPhone(phone, password) {
    if (!validPhone(phone)) throw new Error('Enter a valid 10-digit mobile number.');
    const u = findByPhone(phone);
    if (!u || u.pass !== hash(password)) throw new Error('Wrong number or password.');
    DB.session = u.user_id;
    u.last_seen_at = nowISO();
    save();
    fireAuth();
    return { user: publicUser(u), session: true };
  }

  async function signUpPhone(phone, password, name) {
    if (!validPhone(phone)) throw new Error('Enter a valid 10-digit mobile number.');
    if (String(password).length < 6) throw new Error('Password must be at least 6 characters.');
    if (findByPhone(phone)) throw new Error('That number already has an account. Sign in instead.');
    const id = uid('usr');
    const days = Number(DB.config.trial_days ?? TRIAL_DEFAULT);
    DB.users[id] = {
      user_id: id,
      email: phoneToEmail(phone),
      phone: normalisePhone(phone),
      name: (name || '').trim(),
      pass: hash(password),
      status: 'trial',
      trial_ends_at: new Date(Date.now() + Math.max(0, days) * 86400000).toISOString(),
      access_until: null,
      coupon_used: null,
      note: null,
      created_at: nowISO(),
      last_seen_at: nowISO(),
    };
    DB.session = id;
    save();
    fireAuth();
    return { user: publicUser(DB.users[id]), session: true };
  }

  /* Admin makes an account for someone else without losing their own
     session — the local twin of supabase.js createAccountDetached(). */
  async function createAccountDetached(phone, password, name) {
    if (!validPhone(phone)) throw new Error('Enter a valid 10-digit mobile number.');
    if (String(password).length < 6) throw new Error('Password must be at least 6 characters.');
    if (findByPhone(phone)) throw new Error('That number already has an account.');
    const id = uid('usr');
    DB.users[id] = {
      user_id: id,
      email: phoneToEmail(phone),
      phone: normalisePhone(phone),
      name: (name || '').trim(),
      pass: hash(password),
      status: 'trial',
      trial_ends_at: nowISO(),
      access_until: null,
      coupon_used: null,
      note: null,
      created_at: nowISO(),
      last_seen_at: nowISO(),
    };
    save();                       // note: does NOT touch DB.session
    return { id, phone: normalisePhone(phone) };
  }

  async function updatePassword(password) {
    const u = sessionUser();
    if (!u) throw new Error('Not signed in.');
    if (String(password).length < 6) throw new Error('Password must be at least 6 characters.');
    u.pass = hash(password);
    save();
    return true;
  }

  async function signOut() { DB.session = null; save(); }

  /* ---------- per-user state (kept simple — the store bucket already
       persists everything on-device, so pull is a no-op and push only
       records that this account has chats, for the admin's "has chats"
       badge). ---------- */

  async function pull() { return null; }

  function markData(store) {
    const u = sessionUser();
    if (!u) return;
    let has = false;
    try {
      has = Object.values(store.companions || {}).some((c) => (c.messages || []).length);
    } catch (_) {}
    DB.states[u.user_id] = { updated_at: nowISO(), has_data: has };
    save();
  }
  async function push(store) { if (store) markData(store); return true; }
  function pushDebounced(store) { if (store) markData(store); }

  /* ============================================================
     RPC — the SECURITY DEFINER functions, re-implemented
     ============================================================ */

  function profileJson(u) {
    return {
      ok: true,
      user_id: u.user_id, email: u.email, phone: u.phone, name: u.name,
      status: u.status, trial_ends_at: u.trial_ends_at, access_until: u.access_until,
      created_at: u.created_at, coupon_used: u.coupon_used,
      is_admin: isAdminPhone(u.phone),
      has_access: hasAccess(u),
      server_time: nowISO(),
    };
  }

  async function rpc(fn, args) {
    args = args || {};
    const me = sessionUser();
    const iAmAdmin = !!(me && isAdminPhone(me.phone));

    switch (fn) {
      case 'gf_bootstrap': {
        if (!me) return { ok: false, error: 'not signed in' };
        if (args.p_name && !me.name) me.name = String(args.p_name).trim();
        me.last_seen_at = nowISO();
        save();
        return profileJson(me);
      }

      case 'gf_get_config': {
        if (!me) return { ok: false, error: 'not signed in' };
        if (!(iAmAdmin || hasAccess(me))) return { ok: false, error: 'no access' };
        const c = DB.config;
        return {
          ok: true,
          provider: c.provider, api_key: c.api_key, model: c.model,
          announcement: c.announcement, nsfw_enabled: c.nsfw_enabled,
          updated_at: c.updated_at,
        };
      }

      case 'gf_redeem_coupon': {
        if (!me) return { ok: false, error: 'Please log in first.' };
        const code = String(args.p_code || '').trim().toUpperCase();
        if (!code) return { ok: false, error: 'Enter a coupon code.' };
        const c = DB.coupons.find((x) => String(x.code).toUpperCase() === code);
        if (!c) return { ok: false, error: 'That coupon does not exist.' };
        if (!c.active) return { ok: false, error: 'This coupon has been disabled.' };
        if (c.max_uses > 0 && c.used_count >= c.max_uses) {
          return { ok: false, error: 'This coupon has already been fully used.' };
        }
        if (DB.couponUses.some((x) => x.user_id === me.user_id && String(x.code).toUpperCase() === code)) {
          return { ok: false, error: 'You have already used this coupon.' };
        }
        if (c.days <= 0) {
          me.status = 'active';
          me.access_until = null;
        } else {
          const base = Math.max(me.access_until ? Date.parse(me.access_until) : 0, Date.now());
          me.status = 'active';
          me.access_until = new Date(base + c.days * 86400000).toISOString();
        }
        me.coupon_used = c.code;
        c.used_count += 1;
        DB.couponUses.push({ code: c.code, user_id: me.user_id });
        save();
        return {
          ok: true, days: c.days, status: me.status, access_until: me.access_until,
          message: c.days <= 0 ? 'Lifetime access unlocked 🎉' : `${c.days} days unlocked 🎉`,
        };
      }

      case 'gf_admin_users': {
        if (!iAmAdmin) return { ok: false, error: 'Admins only.' };
        const users = Object.values(DB.users)
          .slice()
          .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
          .map((u) => ({
            user_id: u.user_id, email: u.email, phone: u.phone, name: u.name,
            status: u.status, trial_ends_at: u.trial_ends_at, access_until: u.access_until,
            coupon_used: u.coupon_used, note: u.note,
            created_at: u.created_at, last_seen_at: u.last_seen_at,
            has_access: hasAccess(u),
            has_data: !!(DB.states[u.user_id] && DB.states[u.user_id].has_data),
          }));
        return { ok: true, users, server_time: nowISO() };
      }

      case 'gf_admin_create_profile': {
        if (!iAmAdmin) return { ok: false, error: 'Admins only.' };
        const u = DB.users[args.p_user];
        if (!u) return { ok: false, error: 'No user id given.' };
        const days = Number(args.p_days) || 0;
        const trialDays = Number(DB.config.trial_days ?? TRIAL_DEFAULT);
        if (args.p_name) u.name = String(args.p_name).trim();
        if (args.p_phone) u.phone = normalisePhone(args.p_phone);
        u.trial_ends_at = new Date(Date.now() + Math.max(0, trialDays) * 86400000).toISOString();
        if (days > 0) {
          u.status = 'active';
          u.access_until = new Date(Date.now() + days * 86400000).toISOString();
        } else {
          u.status = 'trial';
          u.access_until = null;
        }
        save();
        return {
          ok: true, user_id: u.user_id, phone: u.phone,
          status: u.status, access_until: u.access_until, has_access: hasAccess(u),
        };
      }

      case 'gf_admin_set_access': {
        if (!iAmAdmin) return { ok: false, error: 'Admins only.' };
        const u = DB.users[args.p_user];
        if (!u) return { ok: false, error: 'User not found.' };
        const days = Number(args.p_days) || 30;
        const action = args.p_action;
        if (action === 'grant') {
          u.status = 'active';
          u.access_until = new Date(Date.now() + days * 86400000).toISOString();
        } else if (action === 'extend') {
          const base = Math.max(u.access_until ? Date.parse(u.access_until) : 0, Date.now());
          u.status = 'active';
          u.access_until = new Date(base + days * 86400000).toISOString();
        } else if (action === 'unlimited') {
          u.status = 'active';
          u.access_until = null;
        } else if (action === 'block') {
          u.status = 'blocked';
        } else if (action === 'unblock') {
          const live = Math.max(u.access_until ? Date.parse(u.access_until) : 0,
                                u.trial_ends_at ? Date.parse(u.trial_ends_at) : 0) > Date.now();
          u.status = live ? 'active' : 'trial';
        } else if (action === 'reset_trial') {
          u.status = 'trial';
          u.access_until = null;
          u.trial_ends_at = new Date(Date.now() + Math.max(1, days) * 86400000).toISOString();
        } else if (action === 'expire') {
          u.status = 'trial';
          u.access_until = null;
          u.trial_ends_at = new Date(Date.now() - 60000).toISOString();
        } else {
          return { ok: false, error: 'Unknown action.' };
        }
        save();
        return {
          ok: true, status: u.status, access_until: u.access_until,
          trial_ends_at: u.trial_ends_at, has_access: hasAccess(u),
        };
      }

      default:
        return { ok: false, error: `Unknown function: ${fn}` };
    }
  }

  /* ============================================================
     table(name) — a minimal, awaitable query builder that mimics
     the slice of the Supabase JS client the admin panel uses:
        .select().eq().order().maybeSingle()
        .insert() / .update().eq() / .delete().eq()
     Every terminal is a thenable resolving to { data, error }.
     ============================================================ */

  function requireAdmin() {
    const me = sessionUser();
    return me && isAdminPhone(me.phone);
  }

  /* Read/write accessors so the builder is table-agnostic. gf_config is a
     single row, exposed as a one-element array. */
  const TABLES = {
    gf_coupons: {
      all: () => DB.coupons,
      set: (rows) => { DB.coupons = rows; },
      pk: 'code',
    },
    gf_personas: {
      all: () => DB.personas,
      set: (rows) => { DB.personas = rows; },
      pk: 'id',
    },
    gf_config: {
      all: () => [DB.config],
      set: (rows) => { if (rows[0]) DB.config = rows[0]; },
      pk: 'id',
    },
  };

  function table(name) {
    const t = TABLES[name];
    const q = {
      _op: 'select',
      _values: null,
      _patch: null,
      _filters: [],
      _order: null,
      _single: false,
      select() { this._op = this._op === 'select' ? 'select' : this._op; return this; },
      insert(v) { this._op = 'insert'; this._values = v; return this; },
      update(p) { this._op = 'update'; this._patch = p; return this; },
      upsert(v) { this._op = 'upsert'; this._values = v; return this; },
      delete() { this._op = 'delete'; return this; },
      eq(col, val) { this._filters.push([col, val]); return this; },
      order(col, opts) { this._order = { col, asc: !(opts && opts.ascending === false) }; return this; },
      maybeSingle() { this._single = true; return this._run(); },
      then(resolve, reject) { return this._run().then(resolve, reject); },
      _match(row) { return this._filters.every(([c, v]) => String(row[c]) === String(v)); },
      async _run() {
        try {
          if (!t) return { data: null, error: { message: `Unknown table ${name}` } };
          const writing = this._op !== 'select';
          if (writing && !requireAdmin()) {
            return { data: null, error: { message: 'Admins only.' } };
          }
          let rows = t.all();

          if (this._op === 'select') {
            let out = rows.filter((r) => this._match(r));
            if (this._order) {
              out = out.slice().sort((a, b) => {
                const av = a[this._order.col], bv = b[this._order.col];
                const cmp = av < bv ? -1 : av > bv ? 1 : 0;
                return this._order.asc ? cmp : -cmp;
              });
            }
            if (this._single) return { data: out[0] || null, error: null };
            return { data: out, error: null };
          }

          if (this._op === 'insert' || this._op === 'upsert') {
            const list = Array.isArray(this._values) ? this._values : [this._values];
            for (const v of list) {
              const row = { ...v };
              // sensible server-side defaults, per table
              if (name === 'gf_coupons') {
                row.code = String(row.code || '').toUpperCase();
                if (rows.some((r) => r.code === row.code) && this._op === 'insert') {
                  return { data: null, error: { message: 'duplicate key value violates unique constraint' } };
                }
                row.days = row.days == null ? 30 : row.days;
                row.max_uses = row.max_uses == null ? 1 : row.max_uses;
                row.used_count = row.used_count || 0;
                row.active = row.active !== false;
                row.note = row.note || null;
                row.created_at = row.created_at || nowISO();
                const i = rows.findIndex((r) => r.code === row.code);
                if (i >= 0) rows[i] = { ...rows[i], ...row }; else rows.push(row);
              } else if (name === 'gf_personas') {
                row.id = row.id || uid('persona');
                row.emoji = row.emoji || '💜';
                row.family = row.family || 'romance';
                row.label = row.label || '';
                row.blurb = row.blurb || '';
                row.spec = row.spec || {};
                row.system_prompt = row.system_prompt || '';
                row.active = row.active !== false;
                row.created_at = row.created_at || nowISO();
                const i = rows.findIndex((r) => r.id === row.id);
                if (i >= 0) rows[i] = { ...rows[i], ...row }; else rows.push(row);
              } else {
                rows.push(row);
              }
            }
            t.set(rows);
            save();
            return { data: list, error: null };
          }

          if (this._op === 'update') {
            let n = 0;
            rows = rows.map((r) => {
              if (this._match(r)) { n++; return { ...r, ...this._patch }; }
              return r;
            });
            t.set(rows);
            save();
            return { data: null, error: null, count: n };
          }

          if (this._op === 'delete') {
            t.set(rows.filter((r) => !this._match(r)));
            save();
            return { data: null, error: null };
          }

          return { data: null, error: { message: 'unsupported op' } };
        } catch (e) {
          return { data: null, error: { message: e.message || 'local error' } };
        }
      },
    };
    return q;
  }

  window.GfLocal = {
    init, currentUser,
    signInPhone, signUpPhone, signOut, updatePassword, createAccountDetached,
    pull, push, pushDebounced,
    rpc, table,
    normalisePhone, validPhone, phoneToEmail,
    isAdminPhone,
    PHONE_DOMAIN,
  };
})();
