/* ============================================================
   admin.js — access control and the admin panel.

   Three globals, the NutriWeb pattern kept intact because it is
   the right one:

     window.GfAccess   entitlement state machine — who you are,
                       what you are allowed, when it expires,
                       and which API keys you get handed
     window.GfGate     the full-screen lock + coupon redemption
     window.GfAdmin    the five-tab admin panel

   Two rules run through the whole file:

     FAIL OPEN ON THE CLIENT, FAIL CLOSED ON THE SERVER.
     hasAccess() returns true whenever it is uncertain, so a
     dropped network never locks a paying user out. The server's
     gf_get_config() returns {ok:false} whenever IT is uncertain,
     so a user who defeats the client lock gets an app with no
     working AI key. The UI gate is cosmetic; the RPC is real.

     NEVER TRUST THE CLIENT FOR ADMIN.
     isAdmin() here only decides whether to draw the panel. Every
     privileged RPC re-checks gf_is_admin() server-side, and the
     anon role has execute revoked on all of them.
   ============================================================ */

(function () {
  'use strict';

  /* ============================================================
     0 · Config — change the email here AND in gf_admin_emails()
     ============================================================ */

  window.GF_ADMIN = window.GF_ADMIN || {
    email: 'grivaaseo@gmail.com',
    name: 'Abhishek',
  };

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => window.GfUI ? GfUI.esc(s) : String(s == null ? '' : s);
  const toast = (m) => { try { GfUI.toast(m); } catch (_) { console.log(m); } };

  /* ============================================================
     1 · Multi-key envelope codec
     ------------------------------------------------------------
     gf_config.api_key is a text column that holds EITHER a raw
     single key (legacy) or a JSON envelope. No migration needed.
       {"v":1,"keys":[{"p":"gemini","k":"...","m":"model"}, ...]}
     Short p/k/m keeps the column small.
     ============================================================ */

  function parseKeyList(c) {
    const rawv = String((c && c.api_key) || '').trim();
    if (!rawv) return [];
    if (rawv.charAt(0) === '{') {
      try {
        const j = JSON.parse(rawv);
        if (Array.isArray(j.keys)) {
          return j.keys
            .map((x) => ({
              provider: x.p || x.provider || 'gemini',
              key: String(x.k || x.key || '').trim(),
              model: x.m || x.model || '',
              label: x.l || x.label || '',
            }))
            .filter((x) => x.key);
        }
      } catch (_) { /* fall through to legacy */ }
    }
    return [{ provider: (c && c.provider) || 'gemini', key: rawv, model: (c && c.model) || '', label: '' }];
  }

  function serialiseKeyList(list) {
    const keys = (list || []).filter((k) => k && k.key).map((k) => ({
      p: k.provider || 'gemini',
      k: String(k.key).trim(),
      m: k.model || '',
      l: k.label || '',
    }));
    return JSON.stringify({ v: 1, keys });
  }

  const maskKey = (k) => {
    const v = String(k || '');
    return v.length <= 12 ? '••••••' : v.slice(0, 6) + '••••••••' + v.slice(-4);
  };

  /* ============================================================
     2 · GfAccess — the entitlement state machine
     ============================================================ */

  const GfAccess = (function () {
    let profile = null;
    let cfg = null;
    let cfgError = '';
    let skewMs = 0;
    let lastCheck = 0;

    const isCloud = () => { try { return !!(window.GfCloud && GfCloud.configured()); } catch (_) { return false; } };
    const signedIn = () => { try { return !!(window.GfCloud && GfCloud.currentUser()); } catch (_) { return false; } };

    /* Expiry is never judged against the device clock. */
    const now = () => Date.now() + skewMs;

    function expiryTs() {
      if (!profile) return 0;
      if (profile.status === 'active' && !profile.access_until) return Infinity;   // lifetime
      const a = profile.access_until ? Date.parse(profile.access_until) : 0;
      const t = profile.trial_ends_at ? Date.parse(profile.trial_ends_at) : 0;
      return Math.max(a || 0, t || 0);
    }

    function hasAccess() {
      if (!isCloud()) return true;      // local-only build — nothing to gate
      if (!signedIn()) return true;     // the login screen handles this
      if (!profile) return true;        // offline / not fetched — never lock out
      if (profile.is_admin) return true;
      if (profile.status === 'blocked') return false;
      return expiryTs() > now();
    }

    const isAdmin = () => !!(profile && profile.is_admin);
    const blocked = () => !!(profile && profile.status === 'blocked');
    const onTrial = () => !!(profile && profile.status === 'trial');

    function msLeft() {
      const t = expiryTs();
      if (t === Infinity) return Infinity;
      return Math.max(0, t - now());
    }
    function daysLeft() {
      const ms = msLeft();
      return ms === Infinity ? Infinity : Math.ceil(ms / 86400000);
    }
    function hoursLeft() {
      const ms = msLeft();
      return ms === Infinity ? Infinity : Math.ceil(ms / 3600000);
    }

    function statusLine() {
      if (!isCloud()) return 'Running local-only. Nothing is gated.';
      if (!profile) return 'Checking your access…';
      if (profile.is_admin) return 'Administrator — full access, always.';
      if (profile.status === 'blocked') return 'Your access has been paused.';
      if (expiryTs() === Infinity) return 'Lifetime access. Nothing expires.';
      const d = daysLeft();
      if (d <= 0) return 'Your access has run out.';
      if (d === 1) return `${hoursLeft()} hours left.`;
      if (profile.status === 'trial') return `Free trial — ${d} days left.`;
      return `${d} days of access left.`;
    }

    async function refresh(nameHint) {
      if (!isCloud() || !signedIn()) { profile = null; return null; }
      try {
        const r = await GfCloud.rpc('gf_bootstrap', { p_name: nameHint || null });
        if (r && r.ok) {
          profile = r;
          if (r.server_time) {
            const st = Date.parse(r.server_time);
            if (!isNaN(st)) skewMs = st - Date.now();
          }
          lastCheck = Date.now();
          try { localStorage.setItem('ariaos.access', JSON.stringify({ p: profile, t: lastCheck })); } catch (_) {}
        }
        return profile;
      } catch (e) {
        // fall back to the last known snapshot so a dropped network never locks anyone out
        if (!profile) {
          try {
            const c = JSON.parse(localStorage.getItem('ariaos.access') || 'null');
            if (c && c.p) profile = c.p;
          } catch (_) {}
        }
        return profile;
      }
    }

    /* The key-distribution mechanism. Keys are memory only, and any key
       left behind by an older build is scrubbed on every launch. */
    function applyConfig(c) {
      if (!c) return;
      const s = window.GfStore?.store?.settings;
      if (!s) return;
      const stamp = String(c.updated_at || '');

      if (s.apiKey) s.apiKey = '';
      if (s.apiKeys && Object.keys(s.apiKeys).length) s.apiKeys = {};

      if (c.announcement != null) s._announcement = c.announcement;

      if (c.provider === 'offline') {
        window.GfKey = window.GfKey || { v: '' };
        GfKey.v = '';
        window.GfKeys = [];
        s._adminCfgAt = stamp;
        window.GfStore.save();
        return;
      }

      if (!c.api_key) { window.GfKeys = []; window.GfKey = { v: '' }; window.GfStore.save(); return; }

      const list = parseKeyList(c);
      window.GfKeys = list;
      window.GfKey = window.GfKey || { v: '' };
      const first = list[0] || { provider: c.provider || 'gemini', key: c.api_key, model: c.model || '' };
      GfKey.v = first.key;
      s.provider = first.provider || 'gemini';
      s.model = first.model || window.GfConfig.DEFAULT_MODEL_FOR(s.provider);
      if (s._adminCfgAt !== stamp) { s._models = {}; s._adminCfgAt = stamp; }
      window.GfStore.save();
    }

    async function syncConfig() {
      cfgError = '';
      if (!isCloud() || !signedIn()) return null;
      try {
        const r = await GfCloud.rpc('gf_get_config');
        if (r && r.ok) { cfg = r; applyConfig(r); return r; }
        cfgError = (r && r.error) || 'no access';
        if (cfgError === 'no access') { window.GfKeys = []; window.GfKey = { v: '' }; }
        return null;
      } catch (e) {
        cfgError = e.message || 'Could not reach the server';
        return null;
      }
    }

    async function redeem(code) {
      const r = await GfCloud.rpc('gf_redeem_coupon', { p_code: String(code || '').trim().toUpperCase() });
      if (!r || !r.ok) throw new Error((r && r.error) || 'That code did not work.');
      return r;
    }

    /* 15-minute poll, plus a check whenever the tab comes back or the
       network returns. Re-enforce the gate only when the boolean flips. */
    function startWatch() {
      if (!isCloud()) return;
      const tick = async () => {
        if (!signedIn()) return;
        if (Date.now() - lastCheck < 60000) return;
        const before = hasAccess();
        await refresh();
        await syncConfig();
        const after = hasAccess();
        if (before !== after) { try { GfGate.enforce(); } catch (_) {} }
        else { try { GfGate.paintBanner(); } catch (_) {} }
      };
      setInterval(tick, 15 * 60 * 1000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
      window.addEventListener('online', tick);
    }

    return {
      get: () => profile,
      config: () => cfg,
      configError: () => cfgError,
      set: (p) => { profile = p; },
      isCloud, signedIn, isAdmin, hasAccess, blocked, onTrial,
      daysLeft, hoursLeft, expiryTs, statusLine, now,
      refresh, syncConfig, startWatch, redeem, applyConfig,
    };
  })();

  /* ============================================================
     3 · GfGate — the lock screen and the coupon flow
     ============================================================ */

  const GfGate = (function () {
    let shown = false;

    const host = () => document.getElementById('gate');

    function hide() {
      const h = host();
      if (!h) return;
      h.classList.add('hidden');
      setTimeout(() => h.classList.add('gone'), 300);
      shown = false;
    }

    function show() {
      const h = host();
      if (!h) return;
      const p = GfAccess.get();
      const isBlocked = GfAccess.blocked();
      h.innerHTML = `
        <section class="gate-card">
          <h2>${isBlocked ? 'Your access is paused' : 'Your access has run out'}</h2>
          <p class="muted" style="font-size:13.5px;line-height:1.55;margin:6px 0 18px">
            ${isBlocked
              ? 'An administrator has paused this account. Get in touch to have it restored.'
              : 'Enter a coupon code to unlock, or ask the admin to extend your access.'}
          </p>

          ${isBlocked ? '' : `
          <div class="field">
            <label class="gate-label" for="gate-code">Coupon code</label>
            <input class="input" id="gate-code" placeholder="ARIA1234" autocomplete="off"
                   autocapitalize="characters" spellcheck="false">
          </div>
          <button class="btn btn--hot btn--wide" id="gate-go">Unlock</button>
          <p class="gate-msg" id="gate-msg"></p>`}

          <hr class="divider">
          <div class="row row--between">
            <span class="mono">${esc((p && p.email) || '')}</span>
            <button class="btn btn--small btn--soft" id="gate-out">Sign out</button>
          </div>
        </section>`;

      h.classList.remove('gone');
      requestAnimationFrame(() => h.classList.remove('hidden'));
      shown = true;

      const go = $('#gate-go');
      if (go) {
        go.onclick = () => doRedeem($('#gate-code'), $('#gate-msg'), go);
        $('#gate-code').addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); go.click(); }
        });
      }
      $('#gate-out').onclick = async () => {
        try { await GfCloud.signOut(); } catch (_) {}
        location.reload();
      };
    }

    async function doRedeem(input, msg, btn) {
      const code = (input?.value || '').trim().toUpperCase();
      if (!code) { if (msg) msg.textContent = 'Enter a code first.'; return; }
      if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
      if (msg) msg.textContent = '';
      try {
        const r = await GfAccess.redeem(code);
        await GfAccess.refresh();
        await GfAccess.syncConfig();
        toast(r.message || 'Unlocked 🎉');
        hide();
        try { GfUI.closeOverlay(); } catch (_) {}
        try { window.GfApp && GfApp.render(); } catch (_) {}
      } catch (e) {
        if (msg) msg.textContent = e.message;
        toast(e.message);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Unlock'; }
      }
    }

    function enforce() {
      if (!GfAccess.isCloud()) { hide(); return; }
      if (GfAccess.hasAccess()) { hide(); paintBanner(); }
      else show();
    }

    /* The trial strip, painted into whatever #trialbanner exists on the
       current page. Hidden for admins and lifetime accounts. */
    function paintBanner() {
      const el = document.getElementById('trialbanner');
      if (!el) return;
      const p = GfAccess.get();
      if (!GfAccess.isCloud() || !p || p.is_admin || GfAccess.expiryTs() === Infinity) {
        el.innerHTML = '';
        return;
      }
      const d = GfAccess.daysLeft();
      if (p.status !== 'trial' && d > 7) { el.innerHTML = ''; return; }
      el.innerHTML = `
        <div class="trialstrip ${d <= 2 ? 'warn' : ''}">
          <span>${esc(GfAccess.statusLine())}</span>
          <button class="trialbtn" data-action="coupon">Have a coupon?</button>
        </div>`;
    }

    /* The same redemption flow, reachable any time from Settings. */
    function couponSheet() {
      GfUI.modal('Redeem a code', `
        <div class="field">
          <label for="cp-code">Coupon code</label>
          <input class="input" id="cp-code" placeholder="ARIA1234" autocomplete="off"
                 autocapitalize="characters" spellcheck="false">
          <span class="hint">Codes stack on top of whatever access you already have.</span>
        </div>
        <button class="btn btn--hot btn--wide" id="cp-go">Unlock</button>
        <p class="gate-msg" id="cp-msg"></p>`);
      setTimeout(() => {
        const go = $('#cp-go');
        if (!go) return;
        go.onclick = () => doRedeem($('#cp-code'), $('#cp-msg'), go);
        $('#cp-code')?.focus();
      }, 30);
    }

    return { enforce, show, hide, paintBanner, couponSheet, isShown: () => shown };
  })();

  /* ============================================================
     4 · GfAdmin — the panel
     ============================================================ */

  const GfAdmin = (function () {
    let tab = 'users';
    let users = [];
    let coupons = [];
    let personas = [];
    let conf = null;
    let q = '';
    let loaded = false;
    let lastError = '';
    let keyDraft = null;
    let keyBusy = false;

    const C = () => window.GfConfig;

    /* ---------- small helpers ---------- */

    const fmtDate = (s) => {
      if (!s) return '—';
      const d = new Date(s);
      return isNaN(d) ? '—' : d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
    };
    const daysTo = (s) => {
      if (!s) return null;
      const d = Date.parse(s);
      return isNaN(d) ? null : Math.ceil((d - Date.now()) / 86400000);
    };
    function timeAgo(s) {
      if (!s) return 'never';
      const ms = Date.now() - Date.parse(s);
      if (isNaN(ms)) return 'never';
      const mins = Math.floor(ms / 60000);
      if (mins < 2) return 'just now';
      if (mins < 60) return `${mins}m ago`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return `${hrs}h ago`;
      const d = Math.floor(hrs / 24);
      return d < 30 ? `${d}d ago` : fmtDate(s);
    }

    /* Status badge: {label, cls} where cls ∈ good | warn | bad */
    function userState(u) {
      if (u.status === 'blocked') return { key: 'blocked', label: 'Blocked', cls: 'bad' };
      if (!u.has_access) return { key: 'expired', label: 'Expired', cls: 'bad' };
      if (u.status === 'active' && !u.access_until) return { key: 'lifetime', label: 'Lifetime', cls: 'good' };
      const d = daysTo(u.access_until || u.trial_ends_at);
      const human = d == null ? '—'
        : d > 365 ? `${Math.floor(d / 365)}y left`
        : d > 30 ? `${Math.floor(d / 30)}mo left`
        : `${d}d left`;
      const prefix = u.status === 'trial' ? 'Trial · ' : '';
      return { key: u.status, label: prefix + human, cls: (d != null && d <= 3) ? 'warn' : 'good' };
    }

    /* The client-side admin hint. Cosmetic only — it exists so an admin
       does not see a flash of "access denied" while the RPC is in flight. */
    function isLocalAdmin() {
      try {
        const A = window.GF_ADMIN || {};
        const email = window.GfStore?.store?.account?.email || '';
        return !!(A.email && email && email.toLowerCase() === A.email.toLowerCase());
      } catch (_) { return false; }
    }

    /* ---------- loading ---------- */

    async function loadUsers() {
      const r = await GfCloud.rpc('gf_admin_users');
      if (!r || !r.ok) throw new Error((r && r.error) || 'Could not load users');
      users = r.users || [];
    }
    async function loadCoupons() {
      const { data, error } = await GfCloud.table('gf_coupons').select('*').order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      coupons = data || [];
    }
    async function loadConfig() {
      const { data, error } = await GfCloud.table('gf_config').select('*').eq('id', 1).maybeSingle();
      if (error) throw new Error(error.message);
      conf = data || { provider: 'gemini', api_key: '', model: '', trial_days: 7, announcement: '', nsfw_enabled: true };
    }
    async function loadPersonas() {
      const { data, error } = await GfCloud.table('gf_personas').select('*').order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      personas = data || [];
    }

    async function loadAll() {
      lastError = '';
      const note = (e) => { console.warn(e); if (!lastError) lastError = (e && e.message) || String(e); };
      await Promise.all([
        loadUsers().catch(note),
        loadCoupons().catch(note),
        loadConfig().catch(note),
        loadPersonas().catch(note),
      ]);
      loaded = true;
    }

    /* Pattern-match the error and print something actionable. */
    function errorBanner() {
      if (!lastError) return '';
      let hint = '';
      if (/schema cache|does not exist|not found in the schema/i.test(lastError)) {
        hint = 'Run <code>sql/SCHEMA.sql</code> in the Supabase SQL editor, then run <code>notify pgrst, \'reload schema\';</code>';
      } else if (/admins only|permission|policy/i.test(lastError)) {
        hint = 'The email you are signed in with is not in <code>gf_admin_emails()</code>. Edit that function and re-run it.';
      } else if (/timeout|network|fetch/i.test(lastError)) {
        hint = 'The project may be paused (Supabase free tier pauses after 7 idle days). Open the dashboard to wake it.';
      }
      return `<div class="notice notice--danger" style="margin-bottom:16px">
        <strong>${esc(lastError)}</strong>${hint ? `<br><span style="opacity:.85">${hint}</span>` : ''}
      </div>`;
    }

    /* ---------- render ---------- */

    function render() {
      const hostEl = document.getElementById('adminHost');
      if (!hostEl) return;

      if (!GfAccess.isCloud()) {
        hostEl.innerHTML = `<div class="empty"><strong>No cloud connected</strong>
          Fill in your Supabase URL and anon key at the top of <code>js/supabase.js</code>,
          then run <code>sql/SCHEMA.sql</code>. Until then the app runs local-only and there is
          nothing to administer.</div>`;
        return;
      }
      if (!GfAccess.isAdmin() && !isLocalAdmin()) {
        hostEl.innerHTML = `<div class="empty"><strong>🔒 Admin access required</strong>
          This account is not an administrator.</div>`;
        return;
      }

      hostEl.innerHTML = `
        <div class="tabs">
          <button class="tab ${tab === 'users' ? 'is-active' : ''}" data-atab="users">👥 Users</button>
          <button class="tab ${tab === 'coupons' ? 'is-active' : ''}" data-atab="coupons">🎟️ Coupons</button>
          <button class="tab ${tab === 'keys' ? 'is-active' : ''}" data-atab="keys">🔑 AI Keys</button>
          <button class="tab ${tab === 'personas' ? 'is-active' : ''}" data-atab="personas">💋 Personas</button>
          <button class="tab ${tab === 'config' ? 'is-active' : ''}" data-atab="config">⚙️ Config</button>
        </div>
        ${errorBanner()}
        <div id="adbody">${loaded ? '' : '<div class="card"><p class="muted">Loading…</p><div class="progbar"></div></div>'}</div>`;

      $$('[data-atab]').forEach((b) => { b.onclick = () => { tab = b.dataset.atab; render(); }; });

      if (!loaded) { loadAll().then(render).catch((e) => toast(e.message)); return; }
      ({ users: drawUsers, coupons: drawCoupons, config: drawConfig, keys: drawKeys, personas: drawPersonas }[tab] || drawUsers)();
    }

    /* ---------- Users ---------- */

    function drawUsers() {
      const body = document.getElementById('adbody');
      if (!body) return;

      const total = users.length;
      const live = users.filter((u) => u.has_access && u.status !== 'blocked').length;
      const trials = users.filter((u) => u.status === 'trial' && u.has_access).length;
      const blocked = users.filter((u) => u.status === 'blocked').length;
      const gone = users.filter((u) => !u.has_access && u.status !== 'blocked').length;

      const stats = [['Total', total, '👥'], ['Active', live, '✅'], ['Trial', trials, '🎁'],
        ['Blocked', blocked, '🚫'], ['Expired', gone, '⏳']]
        .map(([l, v, i]) => `<div class="astat"><div class="ai">${i}</div><div class="at">
          <div class="al">${l}</div><div class="av">${v}</div></div></div>`).join('');

      const needle = q.trim().toLowerCase();
      const shown = !needle ? users : users.filter((u) =>
        `${u.email || ''} ${u.name || ''} ${u.coupon_used || ''}`.toLowerCase().includes(needle));

      const rows = shown.map((u) => {
        const st = userState(u);
        const initial = esc((u.name || u.email || '?').trim().charAt(0).toUpperCase());
        return `<div class="urow">
          <div class="uav">${initial}</div>
          <div class="grow">
            <div class="uname">${esc(u.name || '—')}</div>
            <div class="umail">${esc(u.email || '')}</div>
            <div class="ubadges">
              <span class="abadge ${st.cls}">${esc(st.label)}</span>
              ${u.coupon_used ? `<span class="abadge good">🎟️ ${esc(u.coupon_used)}</span>` : ''}
              ${u.has_data ? '<span class="tag">has chats</span>' : ''}
            </div>
            <div class="umeta">joined ${fmtDate(u.created_at)} · seen ${timeAgo(u.last_seen_at)}</div>
          </div>
          <button class="btn btn--small btn--soft" data-manage="${esc(u.user_id)}">Manage</button>
        </div>`;
      }).join('') || '<div class="empty">Nobody matches that search.</div>';

      body.innerHTML = `
        <div class="astats">${stats}</div>
        <div class="card card--flat">
          <div class="field" style="margin-bottom:14px">
            <input class="input" id="ad-q" placeholder="Search name, email or coupon…" value="${esc(q)}">
          </div>
          ${rows}
        </div>`;

      let t;
      const qi = document.getElementById('ad-q');
      qi.oninput = (e) => {
        clearTimeout(t);
        const v = e.target.value;
        t = setTimeout(() => {
          q = v; drawUsers();
          const el = document.getElementById('ad-q');
          if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
        }, 200);
      };
      $$('[data-manage]').forEach((b) => { b.onclick = () => manageUser(b.dataset.manage); });
    }

    function manageUser(id) {
      const u = users.find((x) => String(x.user_id) === String(id));
      if (!u) return;
      const st = userState(u);

      GfUI.modal(esc(u.name || u.email || 'User'), `
        <p class="muted" style="margin-bottom:4px">${esc(u.email || '')}</p>
        <div class="ubadges" style="margin-bottom:16px">
          <span class="abadge ${st.cls}">${esc(st.label)}</span>
          <span class="tag">${esc(u.status)}</span>
        </div>

        <h3>Grant access from today</h3>
        <div class="chips" style="margin-bottom:16px">
          ${[7, 10, 30, 90, 365].map((d) => `<button class="chip-btn" data-act="grant" data-days="${d}">${d} days</button>`).join('')}
          <button class="chip-btn chip-btn--hot" data-act="unlimited">♾️ Lifetime</button>
        </div>

        <h3>Extend what they already have</h3>
        <div class="chips" style="margin-bottom:16px">
          ${[7, 30, 90, 365].map((d) => `<button class="chip-btn" data-act="extend" data-days="${d}">+${d} days</button>`).join('')}
        </div>

        <h3>Other</h3>
        <div class="chips" style="margin-bottom:14px">
          <button class="chip-btn" data-act="reset_trial" data-days="7">Restart trial</button>
          <button class="chip-btn" data-act="expire">Expire now</button>
          <button class="chip-btn" data-act="${u.status === 'blocked' ? 'unblock' : 'block'}">
            ${u.status === 'blocked' ? '✅ Unblock' : '🚫 Block'}
          </button>
        </div>
        <p class="gate-msg" id="ad-busy"></p>
        <p class="mono" style="margin-top:10px">joined ${fmtDate(u.created_at)} · last seen ${timeAgo(u.last_seen_at)}</p>
      `);

      setTimeout(() => {
        const run = async (action, days) => {
          const busy = document.getElementById('ad-busy');
          if (busy) busy.textContent = 'Saving…';
          try {
            const r = await GfCloud.rpc('gf_admin_set_access', {
              p_user: u.user_id, p_action: action, p_days: days || 30,
            });
            if (!r || !r.ok) throw new Error((r && r.error) || 'Failed');
            await loadUsers();
            GfUI.closeOverlay();
            drawUsers();
            toast('Updated ✅');
          } catch (e) {
            if (busy) busy.textContent = e.message || 'Failed';
            toast(e.message || 'Could not update');
          }
        };
        $$('.modal [data-act]').forEach((b) => {
          b.onclick = () => run(b.dataset.act, +b.dataset.days || 30);
        });
      }, 30);
    }

    /* ---------- Coupons ---------- */

    function genCode() {
      const words = ['ARIA', 'LOVE', 'MINE', 'HERS', 'NIGHT', 'SPICE', 'VIP'];
      const w = words[Math.floor(Math.random() * words.length)];
      const n = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      return w + n;
    }

    function drawCoupons() {
      const body = document.getElementById('adbody');
      if (!body) return;

      const rows = coupons.map((c) => {
        const full = c.max_uses > 0 && c.used_count >= c.max_uses;
        const cls = !c.active ? 'bad' : full ? 'warn' : 'good';
        const lbl = !c.active ? 'Disabled' : full ? 'Fully used' : 'Live';
        const meta = `${c.days <= 0 ? 'Lifetime access' : c.days + ' days'}`
          + ` · used ${c.used_count}${c.max_uses > 0 ? ' / ' + c.max_uses : ' (unlimited)'}`
          + ` · made ${fmtDate(c.created_at)}${c.note ? ' · ' + esc(c.note) : ''}`;
        return `<div class="urow">
          <div class="grow">
            <div class="uname mono" style="font-size:15px;letter-spacing:.06em">${esc(c.code)}</div>
            <div class="ubadges"><span class="abadge ${cls}">${lbl}</span></div>
            <div class="umeta">${meta}</div>
          </div>
          <div class="row row--tight">
            <button class="iconbtn" data-copy="${esc(c.code)}" title="Copy">⧉</button>
            <button class="btn btn--small btn--soft" data-toggle-c="${esc(c.code)}" data-on="${c.active ? '1' : '0'}">
              ${c.active ? 'Disable' : 'Enable'}
            </button>
            <button class="iconbtn iconbtn--danger" data-del-c="${esc(c.code)}" title="Delete">✕</button>
          </div>
        </div>`;
      }).join('') || '<div class="empty">No coupons yet. Make the first one above.</div>';

      body.innerHTML = `
        <div class="card">
          <h2>Make a coupon</h2>
          <div class="grid2">
            <div class="field">
              <label for="cn-code">Code</label>
              <input class="input mono" id="cn-code" value="${genCode()}" autocapitalize="characters">
            </div>
            <div class="field">
              <label for="cn-days">Days of access</label>
              <input class="input" id="cn-days" type="number" value="30" min="0">
              <span class="hint">0 or less = lifetime</span>
            </div>
            <div class="field">
              <label for="cn-uses">How many people can use it</label>
              <input class="input" id="cn-uses" type="number" value="1" min="0">
              <span class="hint">0 or less = unlimited</span>
            </div>
            <div class="field">
              <label for="cn-note">Note (optional)</label>
              <input class="input" id="cn-note" placeholder="Instagram launch">
            </div>
          </div>
          <button class="btn btn--hot" id="cn-go">Generate coupon</button>
        </div>
        <div class="card card--flat" style="margin-top:18px">
          <h2>All coupons</h2>
          ${rows}
        </div>`;

      document.getElementById('cn-go').onclick = async () => {
        const code = (document.getElementById('cn-code').value || '').trim().toUpperCase();
        const days = parseInt(document.getElementById('cn-days').value, 10);
        const uses = parseInt(document.getElementById('cn-uses').value, 10);
        const note = document.getElementById('cn-note').value.trim();
        if (!/^[A-Z0-9_-]{3,24}$/.test(code)) { toast('Code: 3–24 letters or numbers, no spaces.'); return; }
        const btn = document.getElementById('cn-go');
        btn.disabled = true; btn.textContent = 'Creating…';
        try {
          const { error } = await GfCloud.table('gf_coupons').insert({
            code,
            days: isNaN(days) ? 30 : days,
            max_uses: isNaN(uses) ? 1 : uses,
            note: note || null,
          });
          if (error) throw new Error(/duplicate/i.test(error.message) ? 'That code already exists.' : error.message);
          await loadCoupons();
          drawCoupons();
          toast('Coupon created 🎟️');
        } catch (e) {
          btn.disabled = false; btn.textContent = 'Generate coupon';
          toast(e.message);
        }
      };

      $$('[data-copy]').forEach((b) => {
        b.onclick = async () => {
          try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); }
          catch (_) { toast('Could not copy'); }
        };
      });

      $$('[data-toggle-c]').forEach((b) => {
        b.onclick = async () => {
          const on = b.dataset.on === '1';
          const { error } = await GfCloud.table('gf_coupons').update({ active: !on }).eq('code', b.dataset.toggleC);
          if (error) { toast(error.message); return; }
          await loadCoupons(); drawCoupons();
          toast(on ? 'Disabled' : 'Enabled');
        };
      });

      $$('[data-del-c]').forEach((b) => {
        b.onclick = () => {
          const code = b.dataset.delC;
          GfUI.confirm({
            title: `Delete ${code}?`,
            body: 'Anyone who already redeemed it keeps their access. The code just stops working.',
            confirmText: 'Delete',
            onConfirm: async () => {
              const { error } = await GfCloud.table('gf_coupons').delete().eq('code', code);
              if (error) { toast(error.message); return; }
              await loadCoupons(); drawCoupons();
              toast('Deleted');
            },
          });
        };
      });
    }

    /* ---------- AI Keys — the multi-API screen ---------- */

    function readDraft() {
      return {
        provider: document.getElementById('ap-prov')?.value || '',
        key: document.getElementById('ap-key')?.value || '',
        model: document.getElementById('ap-model')?.value || '',
        label: document.getElementById('ap-label')?.value || '',
      };
    }

    async function persist(next, okMsg) {
      const patch = {
        api_key: serialiseKeyList(next),
        provider: (next[0] && next[0].provider) || 'gemini',    // mirror key[0] into the legacy columns
        model: (next[0] && next[0].model) || '',
        updated_at: new Date().toISOString(),
      };
      const { error } = await GfCloud.table('gf_config').update(patch).eq('id', 1);
      if (error) throw new Error(error.message);
      await loadConfig();
      try { await GfAccess.syncConfig(); } catch (_) {}
      toast(okMsg || 'Saved ✅');
      return true;
    }

    async function addKey(test) {
      const msg = document.getElementById('ap-msg');
      const v = readDraft();
      const key = v.key.trim();
      if (!key) { if (msg) msg.textContent = 'Paste a key first.'; return; }

      let prov = v.provider || C().detectProvider(key);
      const model = v.model.trim();

      if (test) {
        keyBusy = true; keyDraft = { ...v, provider: prov }; drawKeys();
        let r = await window.GfApi.testKey(prov, key, model);
        // "sk-…" is ambiguous between OpenAI and DeepSeek — if the guess
        // fails, try the other one before giving up, so pasting just works
        if (!r.ok && /^sk-/.test(key) && !/^sk-ant-/.test(key) && !/^sk-or-/.test(key)) {
          const alt = prov === 'openai' ? 'deepseek' : 'openai';
          const r2 = await window.GfApi.testKey(alt, key, model);
          if (r2.ok) { prov = alt; r = r2; }
        }
        keyBusy = false;
        if (!r.ok) {
          keyDraft = { provider: prov, key, model, label: v.label };
          drawKeys();
          const m2 = document.getElementById('ap-msg');
          if (m2) m2.textContent = '❌ ' + r.message;
          toast('Key failed — not added');
          return;
        }
      }

      const next = parseKeyList(conf || {}).concat([{ provider: prov, key, model, label: v.label.trim() }]);
      keyDraft = null;
      try { if (await persist(next, 'Key added ✅')) drawKeys(); }
      catch (e) { toast(e.message); }
    }

    function drawKeys() {
      const body = document.getElementById('adbody');
      if (!body) return;
      const list = parseKeyList(conf || {});
      const offline = (conf && conf.provider) === 'offline';
      const d = keyDraft || { provider: '', key: '', model: '', label: '' };

      const rows = list.map((k, i) => {
        const meta = C().PROVIDERS[k.provider] || { label: k.provider, icon: '🔑' };
        return `<div class="krow ${i === 0 ? 'is-primary' : ''}">
          <span class="krow__i">${String(i + 1).padStart(2, '0')}</span>
          <span>${meta.icon}</span>
          <div class="grow" style="min-width:0">
            <div class="krow__p">${esc(meta.label)}${i === 0 ? ' · primary' : ''}${k.label ? ' · ' + esc(k.label) : ''}</div>
            <div class="krow__k">${esc(maskKey(k.key))}${k.model ? ' · ' + esc(k.model) : ''}</div>
          </div>
          <button class="iconbtn" data-kup="${i}" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="iconbtn" data-ktest="${i}" title="Test this key">⚡</button>
          <button class="iconbtn iconbtn--danger" data-kdel="${i}" title="Remove">✕</button>
        </div>`;
      }).join('') || '<div class="empty">No keys yet. Add the first one below — everyone signed in will use it.</div>';

      const provOpts = C().PROVIDER_ORDER.map((p) => {
        const m = C().PROVIDERS[p];
        return `<option value="${p}" ${d.provider === p ? 'selected' : ''}>${m.icon} ${m.label}</option>`;
      }).join('');

      body.innerHTML = `
        ${offline ? '<div class="notice notice--warn" style="margin-bottom:16px"><strong>Everyone is switched to offline.</strong> The keys below are kept but nobody is being handed one.</div>' : ''}

        <div class="card card--flat">
          <h2>Keys, in fallback order</h2>
          <p class="muted">Key #1 is used first. If it is rate-limited, expired, or the provider is down,
            the app silently rolls to #2, then #3. Everyone signed in with access gets this list —
            nobody needs their own key.</p>
          <div style="margin-top:14px">${rows}</div>
        </div>

        <div class="card" style="margin-top:18px">
          <h2>Add a key</h2>
          <div class="grid2">
            <div class="field">
              <label for="ap-prov">Provider</label>
              <select class="select" id="ap-prov"><option value="">Detect from the key</option>${provOpts}</select>
            </div>
            <div class="field">
              <label for="ap-model">Model (optional)</label>
              <input class="input" id="ap-model" value="${esc(d.model)}" placeholder="leave blank for the default">
            </div>
          </div>
          <div class="field">
            <label for="ap-key">API key</label>
            <input class="input mono" id="ap-key" value="${esc(d.key)}" placeholder="AIza… / sk-ant-… / gsk_… / sk-…"
                   autocomplete="off" spellcheck="false">
          </div>
          <div class="field">
            <label for="ap-label">Label (optional)</label>
            <input class="input" id="ap-label" value="${esc(d.label)}" placeholder="e.g. billing account 2">
          </div>
          <div class="btnrow">
            <button class="btn" id="ap-test" ${keyBusy ? 'disabled' : ''}>${keyBusy ? 'Testing…' : '⚡ Test and add'}</button>
            <button class="btn btn--soft" id="ap-add">Add without testing</button>
          </div>
          <p class="gate-msg" id="ap-msg"></p>
          <p class="muted" style="font-size:12.5px;margin-top:14px">
            Honest limitation: the app calls the AI straight from the browser, so a key does briefly
            exist in the page's memory and in its network requests. Someone determined, with developer
            tools open, could extract it. That is true of every browser-only app. The mitigation is
            fast rotation from this screen, not prevention.
          </p>
        </div>

        <div class="card" style="margin-top:18px">
          <h2>Kill switch</h2>
          <p class="muted">Switch everyone to offline without deleting anything. Flip it back and the
            same list comes straight back.</p>
          <button class="btn ${offline ? '' : 'btn--danger'}" id="ap-kill" style="margin-top:10px">
            ${offline ? 'Turn the AI back on' : 'Switch everyone to offline'}
          </button>
        </div>`;

      document.getElementById('ap-test').onclick = () => addKey(true);
      document.getElementById('ap-add').onclick = () => addKey(false);

      $$('[data-kup]').forEach((b) => {
        b.onclick = async () => {
          const i = +b.dataset.kup;
          const next = parseKeyList(conf);
          if (i <= 0) return;
          [next[i - 1], next[i]] = [next[i], next[i - 1]];
          try { await persist(next, 'Order changed'); drawKeys(); } catch (e) { toast(e.message); }
        };
      });

      $$('[data-kdel]').forEach((b) => {
        b.onclick = async () => {
          const i = +b.dataset.kdel;
          const next = parseKeyList(conf);
          next.splice(i, 1);
          try { await persist(next, 'Key removed'); drawKeys(); } catch (e) { toast(e.message); }
        };
      });

      $$('[data-ktest]').forEach((b) => {
        b.onclick = async () => {
          const k = parseKeyList(conf)[+b.dataset.ktest];
          if (!k) return;
          b.textContent = '…';
          const r = await window.GfApi.testKey(k.provider, k.key, k.model);
          b.textContent = '⚡';
          toast((r.ok ? '✅ ' : '❌ ') + r.message);
        };
      });

      document.getElementById('ap-kill').onclick = async () => {
        const list = parseKeyList(conf);
        const back = (list[0] && list[0].provider) || 'gemini';
        const { error } = await GfCloud.table('gf_config')
          .update({ provider: offline ? back : 'offline', updated_at: new Date().toISOString() })
          .eq('id', 1);
        if (error) { toast(error.message); return; }
        await loadConfig();
        try { await GfAccess.syncConfig(); } catch (_) {}
        drawKeys();
        toast(offline ? 'AI is back on' : 'Everyone switched to offline');
      };
    }

    /* ---------- Personas — global girls pushed to every user ---------- */

    function drawPersonas() {
      const body = document.getElementById('adbody');
      if (!body) return;

      const rows = personas.map((p) => `<div class="urow">
        <div class="uav">${esc(p.emoji || '💜')}</div>
        <div class="grow">
          <div class="uname">${esc(p.name)}</div>
          <div class="umail">${esc(p.label || '')}</div>
          <div class="ubadges">
            <span class="abadge ${p.active ? 'good' : 'bad'}">${p.active ? 'Live' : 'Hidden'}</span>
            <span class="tag">${esc(p.family || 'romance')}</span>
          </div>
          <div class="umeta">${esc(String(p.blurb || '').slice(0, 140))}</div>
        </div>
        <div class="row row--tight">
          <button class="btn btn--small btn--soft" data-ptog="${esc(p.id)}" data-on="${p.active ? '1' : '0'}">
            ${p.active ? 'Hide' : 'Publish'}
          </button>
          <button class="iconbtn iconbtn--danger" data-pdel="${esc(p.id)}">✕</button>
        </div>
      </div>`).join('') || '<div class="empty">No global personalities yet. Everyone sees the three built-ins.</div>';

      const mine = window.GfStore.list().filter((c) => c.custom);
      const opts = mine.map((c) => `<option value="${esc(c.id)}">${esc(c.emoji)} ${esc(c.name)}</option>`).join('');

      body.innerHTML = `
        <div class="card">
          <h2>Publish one of your own girls to everyone</h2>
          <p class="muted">Anything you built or cloned on this account can be pushed out as a
            personality every user gets. Their chats and memories stay their own — only the
            personality travels.</p>
          ${mine.length ? `
            <div class="field" style="margin-top:14px">
              <label for="pp-pick">Which one</label>
              <select class="select" id="pp-pick">${opts}</select>
            </div>
            <button class="btn btn--hot" id="pp-go">Publish to everyone</button>`
          : '<div class="notice" style="margin-top:14px">Build or clone a girl first, then come back and publish her.</div>'}
        </div>

        <div class="card card--flat" style="margin-top:18px">
          <h2>Published personalities</h2>
          ${rows}
        </div>`;

      const go = document.getElementById('pp-go');
      if (go) {
        go.onclick = async () => {
          const id = document.getElementById('pp-pick').value;
          const c = window.GfStore.store.companions[id];
          if (!c) return;
          go.disabled = true; go.textContent = 'Publishing…';
          try {
            const { error } = await GfCloud.table('gf_personas').insert({
              name: c.name,
              emoji: c.emoji,
              family: c.family || 'romance',
              label: c.spec?.label || '',
              blurb: c.spec?.blurb || '',
              spec: c.spec || {},
              system_prompt: c.systemPrompt || '',
              active: true,
            });
            if (error) throw new Error(error.message);
            await loadPersonas();
            drawPersonas();
            toast('Published 💋');
          } catch (e) { toast(e.message); go.disabled = false; go.textContent = 'Publish to everyone'; }
        };
      }

      $$('[data-ptog]').forEach((b) => {
        b.onclick = async () => {
          const on = b.dataset.on === '1';
          const { error } = await GfCloud.table('gf_personas').update({ active: !on }).eq('id', b.dataset.ptog);
          if (error) { toast(error.message); return; }
          await loadPersonas(); drawPersonas();
        };
      });

      $$('[data-pdel]').forEach((b) => {
        b.onclick = () => {
          GfUI.confirm({
            title: 'Remove this personality?',
            body: 'She disappears from everyone\'s list. Chats people already had with her are kept on their device.',
            confirmText: 'Remove',
            onConfirm: async () => {
              const { error } = await GfCloud.table('gf_personas').delete().eq('id', b.dataset.pdel);
              if (error) { toast(error.message); return; }
              await loadPersonas(); drawPersonas();
            },
          });
        };
      });
    }

    /* ---------- Config ---------- */

    async function saveConf(patch, okMsg) {
      const msg = document.getElementById('cfg-msg');
      try {
        const { error } = await GfCloud.table('gf_config')
          .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', 1);
        if (error) throw new Error(error.message);
        await loadConfig();
        if (msg) msg.textContent = okMsg || 'Saved';
        toast(okMsg || 'Saved');
        try { await GfAccess.syncConfig(); } catch (_) {}
        return true;
      } catch (e) {
        if (msg) msg.textContent = e.message;
        toast(e.message);
        return false;
      }
    }

    function drawConfig() {
      const body = document.getElementById('adbody');
      if (!body) return;
      const c = conf || {};

      body.innerHTML = `
        <div class="card">
          <h2>Free trial</h2>
          <p class="muted">How many days a brand-new signup gets before the gate closes. Set 0 to
            turn trials off entirely — then nobody gets in without a coupon.</p>
          <div class="field" style="max-width:200px;margin-top:14px">
            <label for="cf-trial">Trial days</label>
            <input class="input" id="cf-trial" type="number" min="0" value="${Number(c.trial_days ?? 7)}">
          </div>
          <button class="btn" id="cf-trial-go">Save</button>
        </div>

        <div class="card" style="margin-top:18px">
          <h2>Announcement</h2>
          <p class="muted">Shows on everyone's Settings page. Leave it empty to show nothing.</p>
          <div class="field" style="margin-top:14px">
            <textarea class="input textarea" id="cf-ann" style="min-height:100px"
              placeholder="New personality dropped tonight 🔥">${esc(c.announcement || '')}</textarea>
          </div>
          <button class="btn" id="cf-ann-go">Save</button>
        </div>

        <div class="card" style="margin-top:18px">
          <h2>Content</h2>
          <div class="row row--between" style="margin-top:6px">
            <div style="max-width:70%">
              <strong style="font-size:14px">Adult mode, globally</strong>
              <p class="muted" style="margin:4px 0 0">On (the default): the spicy mood is fully
                uninhibited for everyone. Off: every account is capped at flirty, no matter what
                they pick on their own device.</p>
            </div>
            <button class="switch ${c.nsfw_enabled !== false ? 'on' : ''}" id="cf-nsfw" aria-label="Adult mode"></button>
          </div>
        </div>

        <div class="card" style="margin-top:18px">
          <h2>Bulk actions</h2>
          <p class="muted">These loop through every user one at a time. On a big list it takes a moment.</p>
          <div class="btnrow" style="margin-top:12px">
            <button class="btn btn--soft" id="cf-unblock">Unblock everyone</button>
            <button class="btn btn--danger" id="cf-expire">Expire everyone (keeps lifetime accounts)</button>
          </div>
          <p class="gate-msg" id="cfg-msg"></p>
        </div>

        <div class="card card--flat" style="margin-top:18px">
          <h2>Health</h2>
          <div class="prow"><span class="pl">Supabase project</span><span class="pv mono">${esc((GfCloud.settings.url || '').replace(/^https?:\/\//, '') || 'not set')}</span></div>
          <div class="prow"><span class="pl">Admin email</span><span class="pv mono">${esc(window.GF_ADMIN.email)}</span></div>
          <div class="prow"><span class="pl">Keys loaded</span><span class="pv">${parseKeyList(c).length}</span></div>
          <div class="prow"><span class="pl">Users</span><span class="pv">${users.length}</span></div>
          <div class="prow"><span class="pl">Config updated</span><span class="pv">${timeAgo(c.updated_at)}</span></div>
        </div>`;

      document.getElementById('cf-trial-go').onclick = () =>
        saveConf({ trial_days: Math.max(0, parseInt(document.getElementById('cf-trial').value, 10) || 0) }, 'Trial length saved');

      document.getElementById('cf-ann-go').onclick = () =>
        saveConf({ announcement: document.getElementById('cf-ann').value.trim() }, 'Announcement saved');

      document.getElementById('cf-nsfw').onclick = async (e) => {
        const on = !e.currentTarget.classList.contains('on');
        e.currentTarget.classList.toggle('on', on);
        await saveConf({ nsfw_enabled: on }, on ? 'Adult mode on' : 'Adult mode off, globally');
      };

      const bulk = async (action, label) => {
        const msg = document.getElementById('cfg-msg');
        let done = 0;
        for (const u of users) {
          if (action === 'expire' && u.status === 'active' && !u.access_until) continue;   // keep lifetime
          if (action === 'unblock' && u.status !== 'blocked') continue;
          try {
            await GfCloud.rpc('gf_admin_set_access', { p_user: u.user_id, p_action: action, p_days: 30 });
            done++;
            if (msg) msg.textContent = `${label}: ${done}…`;
          } catch (_) {}
        }
        await loadUsers();
        if (msg) msg.textContent = `${label}: ${done} done.`;
        toast(`${label}: ${done} accounts`);
      };

      document.getElementById('cf-unblock').onclick = () => bulk('unblock', 'Unblocked');
      document.getElementById('cf-expire').onclick = () => {
        GfUI.confirm({
          title: 'Expire everyone?',
          body: 'Every non-lifetime account loses access immediately. Coupons and lifetime accounts are untouched.',
          confirmText: 'Expire them',
          onConfirm: () => bulk('expire', 'Expired'),
        });
      };
    }

    return {
      render,
      reload: async () => { loaded = false; await loadAll(); render(); },
      invalidate: () => { loaded = false; },
      parseKeyList, serialiseKeyList, maskKey,
      isLocalAdmin,
      get personas() { return personas; },
    };
  })();

  window.GfAccess = GfAccess;
  window.GfGate = GfGate;
  window.GfAdmin = GfAdmin;
})();
