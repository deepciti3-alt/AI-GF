/* ============================================================
   supabase.js — the cloud layer.  window.GfCloud

   Everyone signs in with a MOBILE NUMBER and a password. There is
   no email anywhere in the interface.

   TWO BACKENDS, ONE INTERFACE
   ------------------------------------------------------------
   • Fill in the Supabase URL + anon key below and GfCloud talks to
     your real Supabase project — many users, many devices, proper
     server-side security (see sql/SCHEMA.sql).

   • Leave them BLANK and GfCloud automatically routes to GfLocal
     (js/local.js), a self-contained backend that lives entirely in
     this browser. You still get a real login screen, the admin
     panel, coupons and the shared multi-API key list — with zero
     setup, working on any static host. This is what makes the app
     usable the moment you open it, instead of falling into a
     login-less local-only mode.

     Admin signs in with the number + password in window.GF_ADMIN
     (js/local.js / js/admin.js). Everyone else signs up with their
     own number.

   How mobile login works on real Supabase without an SMS provider
   ------------------------------------------------------------
   Supabase's real phone auth needs a paid SMS gateway because it
   wants to send an OTP. We don't want an OTP — we want a number and
   a password. So every mobile number is mapped to a synthetic
   address:

       9873393559   →   9873393559@ariaos.app

   and we use ordinary email+password auth underneath. Nobody ever
   sees that address. Turn "Confirm email" OFF in Supabase and
   phone-number login works on the free tier, instantly.

   ⚠️  PUT YOUR OWN PROJECT URL AND ANON KEY BELOW to go multi-device.
   The anon key is designed to be public — every real permission is
   enforced by RLS and SECURITY DEFINER functions in sql/SCHEMA.sql.
   NEVER put the service_role key in this file.
   ============================================================ */

(function () {
  'use strict';

  const GF_SUPABASE = {
    url: 'https://ldsoargzklmdwppauoje.supabase.co',        // e.g. https://xxxxxxxxxxxx.supabase.co
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxkc29hcmd6a2xtZHdwcGF1b2plIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3MDYyMTIsImV4cCI6MjEwMjI4MjIxMn0.oKO_lvCyKsWqwepzb964WyzTK4X4hA2ebBv2udwX2Tk',    // the "anon public" key from Settings → API
  };

  const PHONE_DOMAIN = 'ariaos.app';
  const SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';

  let sb = null;
  let ready = false;
  let user = null;
  let onAuthChange = null;
  let pushT = null;
  let pendingStore = null;

  /* Which backend are we on? Real Supabase when both keys are present;
     otherwise the in-browser GfLocal backend. */
  const hasRealCloud = () => !!(GF_SUPABASE.url && GF_SUPABASE.anonKey);
  const local = () => window.GfLocal || null;
  const useLocal = () => !hasRealCloud() && !!local();

  /* configured() is true whenever a backend exists at all — real or local.
     This is what turns the login screen, the gate and the admin panel on.
     It only returns false in the legacy "no local.js, no keys" case, which
     keeps the old bring-your-own-key-in-Settings behaviour available. */
  const configured = () => hasRealCloud() || !!local();
  const isEnabled = () => useLocal() ? true : (ready && !!sb);
  const currentUser = () => useLocal() ? local().currentUser() : user;
  const raw = () => sb;

  /* ============================================================
     Phone helpers — pure, shared by both backends
     ============================================================ */

  function normalisePhone(input) {
    let d = String(input || '').replace(/\D/g, '');
    if (d.length > 10 && d.startsWith('91')) d = d.slice(2);
    if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
    return d;
  }
  function validPhone(input) {
    const d = normalisePhone(input);
    return d.length >= 10 && d.length <= 15;
  }
  const phoneToEmail = (phone) => `${normalisePhone(phone)}@${PHONE_DOMAIN}`;
  function emailToPhone(email) {
    const e = String(email || '');
    if (e.endsWith('@' + PHONE_DOMAIN)) return e.slice(0, -(PHONE_DOMAIN.length + 1));
    return e;
  }
  function prettyPhone(phone) {
    const d = normalisePhone(phone);
    return d.length === 10 ? `${d.slice(0, 5)} ${d.slice(5)}` : d;
  }

  /* ============================================================
     Init
     ============================================================ */

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

    // No real keys → run entirely in the browser via GfLocal.
    if (useLocal()) {
      const r = local().init(authCb);
      return { enabled: true, user: r.user };
    }

    if (!hasRealCloud()) return { enabled: false };   // no local.js either — legacy path

    try {
      if (!window.supabase) await loadScript(SDK);
      sb = window.supabase.createClient(GF_SUPABASE.url, GF_SUPABASE.anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      });
      ready = true;

      const { data } = await sb.auth.getSession();
      user = data?.session?.user || null;

      sb.auth.onAuthStateChange((event, session) => {
        user = session?.user || null;
        if (onAuthChange) onAuthChange(user);
      });

      return { enabled: true, user };
    } catch (e) {
      console.warn('cloud init failed', e);
      ready = false;
      return { enabled: false, error: e.message };
    }
  }

  /* ============================================================
     Auth — mobile number + password
     ============================================================ */

  function friendlyAuthError(message) {
    const m = String(message || '');
    if (/invalid login credentials/i.test(m)) return 'Wrong number or password.';
    if (/already registered|already been registered|user already/i.test(m)) return 'That number already has an account. Sign in instead.';
    if (/password should be at least/i.test(m)) return 'Password must be at least 6 characters.';
    if (/email address .* is invalid/i.test(m)) return 'That does not look like a valid mobile number.';
    if (/rate limit|too many/i.test(m)) return 'Too many attempts. Wait a minute and try again.';
    if (/confirm/i.test(m)) return 'Email confirmation is still switched on in Supabase. Turn it off — see SETUP-SUPABASE.md step 6.';
    return m || 'Something went wrong.';
  }

  async function signUpPhone(phone, password, name) {
    if (useLocal()) return local().signUpPhone(phone, password, name);
    if (!validPhone(phone)) throw new Error('Enter a valid 10-digit mobile number.');
    if (String(password).length < 6) throw new Error('Password must be at least 6 characters.');
    const { data, error } = await sb.auth.signUp({
      email: phoneToEmail(phone),
      password,
      options: { data: { name: name || '', phone: normalisePhone(phone) } },
    });
    if (error) throw new Error(friendlyAuthError(error.message));
    if (!data.session) {
      throw new Error('Account made, but Supabase is still asking for email confirmation. Turn "Confirm email" off — see SETUP-SUPABASE.md step 6.');
    }
    return data;
  }

  async function signInPhone(phone, password) {
    if (useLocal()) return local().signInPhone(phone, password);
    if (!validPhone(phone)) throw new Error('Enter a valid 10-digit mobile number.');
    const { data, error } = await sb.auth.signInWithPassword({
      email: phoneToEmail(phone),
      password,
    });
    if (error) throw new Error(friendlyAuthError(error.message));
    return data;
  }

  async function updatePassword(password) {
    if (useLocal()) return local().updatePassword(password);
    if (String(password).length < 6) throw new Error('Password must be at least 6 characters.');
    const { error } = await sb.auth.updateUser({ password });
    if (error) throw new Error(friendlyAuthError(error.message));
    return true;
  }

  async function signOut() {
    if (useLocal()) { await local().signOut(); return; }
    try { await sb.auth.signOut(); } catch (_) {}
    user = null;
  }

  async function createAccountDetached(phone, password, name) {
    if (useLocal()) return local().createAccountDetached(phone, password, name);
    if (!isEnabled()) throw new Error('Cloud not configured');
    if (!validPhone(phone)) throw new Error('Enter a valid 10-digit mobile number.');
    if (String(password).length < 6) throw new Error('Password must be at least 6 characters.');

    const tmp = window.supabase.createClient(GF_SUPABASE.url, GF_SUPABASE.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'gf-tmp-' + Math.random().toString(36).slice(2) },
    });

    const { data, error } = await tmp.auth.signUp({
      email: phoneToEmail(phone),
      password,
      options: { data: { name: name || '', phone: normalisePhone(phone) } },
    });
    try { await tmp.auth.signOut(); } catch (_) {}

    if (error) throw new Error(friendlyAuthError(error.message));
    const id = data?.user?.id;
    if (!id) throw new Error('Supabase did not return a user id. Check that "Confirm email" is off.');
    return { id, phone: normalisePhone(phone) };
  }

  /* ============================================================
     State sync — one JSON row per user
     ============================================================ */

  function withTimeout(promise, ms, fallback) {
    return Promise.race([promise, new Promise((res) => setTimeout(() => res(fallback), ms))]);
  }

  async function pull() {
    if (useLocal()) return local().pull();
    if (!isEnabled() || !user) return null;
    const q = sb.from('gf_state').select('data, updated_at').eq('user_id', user.id).maybeSingle();
    const { data, error } = await withTimeout(q, 10000, { data: null, error: { message: 'timeout' } });
    if (error || !data) return null;
    return data.data || null;
  }

  async function push(storeObj) {
    if (useLocal()) return local().push(storeObj);
    if (!isEnabled() || !user || !storeObj) return false;
    const clean = JSON.parse(JSON.stringify(storeObj));
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
    if (useLocal()) { local().pushDebounced(storeObj); return; }
    if (!isEnabled() || !user) return;
    pendingStore = storeObj;
    clearTimeout(pushT);
    pushT = setTimeout(() => { const s = pendingStore; pendingStore = null; push(s); }, 1500);
  }

  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && pendingStore && !useLocal() && isEnabled() && user) {
      clearTimeout(pushT);
      const s = pendingStore; pendingStore = null;
      push(s);
    }
  });

  /* ============================================================
     Low-level, used by admin.js
     ============================================================ */

  async function rpc(fn, args) {
    if (useLocal()) return local().rpc(fn, args || {});
    if (!isEnabled()) throw new Error('Cloud not configured');
    const { data, error } = await withTimeout(
      sb.rpc(fn, args || {}), 15000,
      { data: null, error: { message: 'Network timeout' } },
    );
    if (error) throw new Error(error.message || 'Request failed');
    return data;
  }

  function table(name) {
    if (useLocal()) return local().table(name);
    if (!isEnabled()) throw new Error('Cloud not configured');
    return sb.from(name);
  }

  window.GfCloud = {
    init, isEnabled, configured, currentUser, raw,
    normalisePhone, validPhone, phoneToEmail, emailToPhone, prettyPhone,
    signUpPhone, signInPhone, updatePassword, signOut, createAccountDetached,
    pull, push, pushDebounced,
    rpc, table,
    settings: GF_SUPABASE,
    PHONE_DOMAIN,
    /* true when running on the built-in in-browser backend (no Supabase) */
    isLocalMode: () => useLocal(),
  };
})();
