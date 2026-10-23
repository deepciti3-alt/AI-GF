/* ============================================================
   supabase.js — the cloud layer.  window.GfCloud

   Everyone signs in with a MOBILE NUMBER and a password. There is
   no email anywhere in the interface.

   How that works without an SMS provider
   ------------------------------------------------------------
   Supabase's real phone auth needs a paid SMS gateway (Twilio or
   similar) because it wants to send an OTP. We don't want an OTP —
   we want a number and a password. So every mobile number is
   mapped to a synthetic address:

       98765 43210   →   9876543210@ariaos.app

   and we use ordinary email+password auth underneath. Nobody ever
   sees that address; it is an internal key. Turn "Confirm email"
   OFF in Supabase (there is no inbox to confirm) and phone-number
   login works on the free tier, instantly, with no SMS bill.

   The number is also stored properly in gf_profiles.phone, so the
   admin panel searches and displays real numbers.

   ⚠️  PUT YOUR OWN PROJECT URL AND ANON KEY BELOW.
   The anon key is designed to be public — every real permission is
   enforced by RLS and by SECURITY DEFINER functions in
   sql/SCHEMA.sql. NEVER put the service_role key in this file.

   Leave both blank and the app runs local-only: no login, no gate,
   no admin, bring your own key in Settings.
   ============================================================ */

(function () {
  'use strict';

  const GF_SUPABASE = {
    url: 'https://ldsoargzklmdwppauoje.supabase.co',        // e.g. https://xxxxxxxxxxxx.supabase.co
      anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxkc29hcmd6a2xtZHdwcGF1b2plIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3MDYyMTIsImV4cCI6MjEwMjI4MjIxMn0.oKO_lvCyKsWqwepzb964WyzTK4X4hA2ebBv2udwX2Tk',    // the "anon public" key from Settings -> API
  };

  /* The internal domain the synthetic addresses live on. It never needs to
     exist or receive mail — it is only a unique key for the auth table. */
  const PHONE_DOMAIN = 'ariaos.app';

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

  /* ============================================================
     Phone helpers
     ============================================================ */

  /* Strip everything that isn't a digit, then drop an Indian country code
     so +91 98765 43210, 09876543210 and 9876543210 are all the same person. */
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

  /* Turn an internal address back into the number, for display. */
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

  let initPromise = null;
  let initError = '';

  async function init(authCb) {
    if (authCb) onAuthChange = authCb;
    if (!configured()) return { enabled: false };
    if (ready && sb) return { enabled: true, user };
    // one init at a time — boot() and a retry from the login form must not race
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        if (!window.supabase) await loadScript(SDK);
        sb = window.supabase.createClient(GF_SUPABASE.url, GF_SUPABASE.anonKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
        });

        const { data } = await sb.auth.getSession();
        user = data?.session?.user || null;

        sb.auth.onAuthStateChange((event, session) => {
          const next = session?.user || null;
          user = next;
          // A silent hourly token refresh is not a new login. Re-running the whole
          // sign-in path for it re-opens the store and re-pulls from the cloud.
          if (event === 'TOKEN_REFRESHED') return;
          // IMPORTANT: never call another Supabase method (rpc, from, ...) from inside
          // this callback. supabase-js holds its auth lock while it runs the callback,
          // and rpc() needs that same lock to read the session, so the sign-in call
          // never resolves and the login button hangs. Defer to the next tick.
          if (onAuthChange) setTimeout(() => { try { onAuthChange(next, event); } catch (e) { console.warn(e); } }, 0);
        });

        ready = true;
        initError = '';
        return { enabled: true, user };
      } catch (e) {
        console.warn('cloud init failed', e);
        ready = false;
        sb = null;
        initError = e.message || 'Could not reach the server.';
        return { enabled: false, error: initError };
      } finally {
        initPromise = null;
      }
    })();
    return initPromise;
  }

  /* The login form calls this before every attempt. If the very first init
     failed (slow CDN, offline at launch) the old code left sb = null and the
     next click threw "Cannot read properties of null". Retry instead. */
  async function ensureReady() {
    if (isEnabled()) return;
    await init();
    if (!isEnabled()) {
      throw new Error('Could not connect to the server. Check your internet and try again.');
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
    // Supabase rejected the synthetic address itself (domain check). This is a
    // server-side setting, NOT a typo by the user — say so instead of blaming the number.
    if (/email address .* is invalid|email_address_invalid|unable to validate email/i.test(m)) {
      return 'The server rejected the login address for this number (setup issue, not your number). Admin: see SETUP-SUPABASE.md → Troubleshooting.';
    }
    if (/signups? not allowed|signup.* disabled|email.*(logins?|signups?).* disabled|provider is not enabled/i.test(m)) {
      return 'Sign-up/sign-in with a password is switched off in Supabase. Admin: Authentication → Providers → Email → enable it.';
    }
    if (/rate limit|too many|over_email_send_rate_limit/i.test(m)) return 'Too many attempts. Wait a minute and try again.';
    if (/failed to fetch|networkerror|network request failed|load failed/i.test(m)) return 'Could not reach the server. Check your internet and try again.';
    if (/email not confirmed|confirm/i.test(m)) return 'Email confirmation is still switched on in Supabase. Turn it off — see SETUP-SUPABASE.md step 6.';
    return m || 'Something went wrong.';
  }

  async function signUpPhone(phone, password, name) {
    if (!validPhone(phone)) throw new Error('Enter a valid 10-digit mobile number.');
    if (String(password).length < 6) throw new Error('Password must be at least 6 characters.');
    await ensureReady();
    const { data, error } = await sb.auth.signUp({
      email: phoneToEmail(phone),
      password,
      options: { data: { name: name || '', phone: normalisePhone(phone) } },
    });
    if (error) throw new Error(friendlyAuthError(error.message));
    // Confirm-email left on → no session comes back. Say so plainly.
    if (!data.session) {
      throw new Error('Account made, but Supabase is still asking for email confirmation. Turn "Confirm email" off — see SETUP-SUPABASE.md step 6.');
    }
    return data;
  }

  async function signInPhone(phone, password) {
    if (!validPhone(phone)) throw new Error('Enter a valid 10-digit mobile number.');
    await ensureReady();
    const { data, error } = await sb.auth.signInWithPassword({
      email: phoneToEmail(phone),
      password,
    });
    if (error) throw new Error(friendlyAuthError(error.message));
    return data;
  }

  async function updatePassword(password) {
    if (String(password).length < 6) throw new Error('Password must be at least 6 characters.');
    await ensureReady();
    const { error } = await sb.auth.updateUser({ password });
    if (error) throw new Error(friendlyAuthError(error.message));
    return true;
  }

  async function signOut() {
    try { if (sb) await sb.auth.signOut(); } catch (_) {}
    user = null;
  }

  /* ------------------------------------------------------------
     Admin creating an account for somebody else.

     signUp() on the MAIN client would swap the admin's own session
     for the new user's. So we spin up a second, detached client
     with persistSession:false — it shares nothing, writes nothing
     to storage, and is thrown away immediately. The admin stays
     logged in as the admin throughout.

     This needs no service_role key.
     ------------------------------------------------------------ */
  async function createAccountDetached(phone, password, name) {
    await ensureReady();
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

  /* ============================================================
     Low-level, used by admin.js
     ============================================================ */

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
    init, ensureReady, isEnabled, configured, currentUser, raw,
    normalisePhone, validPhone, phoneToEmail, emailToPhone, prettyPhone,
    signUpPhone, signInPhone, updatePassword, signOut, createAccountDetached,
    pull, push, pushDebounced,
    rpc, table,
    settings: GF_SUPABASE,
    PHONE_DOMAIN,
  };
})();
