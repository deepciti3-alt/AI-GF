/* ============================================================
   supabase.js — the cloud layer.  window.GfCloud

   Same shape as NutriWeb's NutriCloud: a thin wrapper around
   supabase-js v2, loaded lazily from a CDN so there is no build
   step and no bundler.

   It does four things:
     • auth (email + password, reset, optional phone OTP)
     • one JSON row per user, whole-store snapshot, debounced
     • rpc()   — the escape hatch admin.js uses
     • table() — the escape hatch admin.js uses

   ⚠️  PUT YOUR OWN PROJECT URL AND ANON KEY BELOW.
   The anon key is designed to be public — every real permission
   is enforced by RLS and by SECURITY DEFINER functions in
   sql/SCHEMA.sql. NEVER put the service_role key in this file.

   Leave both blank and the whole app runs happily local-only:
   no login, no gate, no admin, bring your own API key in Settings.
   ============================================================ */

(function () {
  'use strict';

  const GF_SUPABASE = {
    url: '',        // e.g. https://xxxxxxxxxxxx.supabase.co
    anonKey: '',    // the "anon public" key from Settings → API
  };

  const SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';

  let sb = null;
  let ready = false;
  let user = null;
  let onAuthChange = null;
  let pushT = null;
  let pendingStore = null;

  const configured = () => !!(GF_SUPABASE.url && GF_SUPABASE.anonKey);
  const isEnabled = () => ready && !!sb;
  const currentUser = () => user;
  const raw = () => sb;

  /* Guard every network call so a slow or unreachable backend can never
     hang the interface. */
  function withTimeout(promise, ms, fallback) {
    return Promise.race([
      promise,
      new Promise((res) => setTimeout(() => res(fallback), ms)),
    ]);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load the cloud library.'));
      document.head.appendChild(s);
    });
  }

  async function init(authCb) {
    onAuthChange = authCb || null;
    if (!configured()) return { enabled: false };
    try {
      if (!window.supabase) await loadScript(SDK);
      sb = window.supabase.createClient(GF_SUPABASE.url, GF_SUPABASE.anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
      ready = true;

      const { data } = await sb.auth.getSession();
      user = data?.session?.user || null;

      sb.auth.onAuthStateChange((event, session) => {
        user = session?.user || null;
        if (event === 'PASSWORD_RECOVERY' && typeof window.GfOnRecovery === 'function') {
          window.GfOnRecovery();
          return;
        }
        if (onAuthChange) onAuthChange(user);
      });

      return { enabled: true, user };
    } catch (e) {
      console.warn('cloud init failed', e);
      ready = false;
      return { enabled: false, error: e.message };
    }
  }

  /* ---------- auth ---------- */

  async function signUpEmail(email, password, name) {
    const { data, error } = await sb.auth.signUp({
      email, password, options: { data: { name: name || '' } },
    });
    if (error) throw new Error(error.message);
    return data;
  }

  async function signInEmail(email, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    return data;
  }

  async function sendReset(email) {
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: location.origin + location.pathname,
    });
    if (error) throw new Error(error.message);
    return true;
  }

  async function updatePassword(password) {
    const { error } = await sb.auth.updateUser({ password });
    if (error) throw new Error(error.message);
    return true;
  }

  async function sendPhoneOtp(phone) {
    const { error } = await sb.auth.signInWithOtp({ phone });
    if (error) throw new Error(error.message);
    return true;
  }

  async function verifyPhoneOtp(phone, token) {
    const { data, error } = await sb.auth.verifyOtp({ phone, token, type: 'sms' });
    if (error) throw new Error(error.message);
    return data;
  }

  async function signOut() {
    try { await sb.auth.signOut(); } catch (_) {}
    user = null;
  }

  /* ---------- state sync: one JSON row per user ---------- */

  async function pull() {
    if (!isEnabled() || !user) return null;
    const q = sb.from('gf_state').select('data, updated_at').eq('user_id', user.id).maybeSingle();
    const { data, error } = await withTimeout(q, 10000, { data: null, error: { message: 'timeout' } });
    if (error || !data) return null;
    return data.data || null;
  }

  async function push(storeObj) {
    if (!isEnabled() || !user || !storeObj) return false;
    const clean = JSON.parse(JSON.stringify(storeObj));
    // an API key must never travel inside a user's snapshot
    if (clean.settings) {
      clean.settings.apiKey = '';
      clean.settings.apiKeys = {};
      clean.settings.geminiKey = '';
    }
    delete clean.account;
    const q = sb.from('gf_state').upsert(
      { user_id: user.id, data: clean, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    );
    const { error } = await withTimeout(q, 12000, { error: { message: 'timeout' } });
    if (error) { console.warn('cloud push failed', error.message); return false; }
    return true;
  }

  function pushDebounced(storeObj) {
    if (!isEnabled() || !user) return;
    pendingStore = storeObj;
    clearTimeout(pushT);
    pushT = setTimeout(() => { const s = pendingStore; pendingStore = null; push(s); }, 1500);
  }

  // flush on tab hide so a debounced write is never lost
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && pendingStore && isEnabled() && user) {
      clearTimeout(pushT);
      const s = pendingStore; pendingStore = null;
      push(s);
    }
  });

  /* ---------- low-level, used by admin.js ---------- */

  async function rpc(fn, args) {
    if (!isEnabled()) throw new Error('Cloud not configured');
    const { data, error } = await withTimeout(
      sb.rpc(fn, args || {}), 15000,
      { data: null, error: { message: 'Network timeout' } },
    );
    if (error) throw new Error(error.message || 'Request failed');
    return data;
  }

  function table(name) {
    if (!isEnabled()) throw new Error('Cloud not configured');
    return sb.from(name);
  }

  window.GfCloud = {
    init, isEnabled, configured, currentUser, raw,
    signUpEmail, signInEmail, sendReset, updatePassword,
    sendPhoneOtp, verifyPhoneOtp, signOut,
    pull, push, pushDebounced,
    rpc, table,
    settings: GF_SUPABASE,
  };
})();
