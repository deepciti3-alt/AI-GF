/* ============================================================
   app.js — the application.  window.GfApp

   Architecture, borrowed wholesale from Advisor OS because it is
   the right one for a no-build single-page app:

     • every renderX() is a PURE STRING FUNCTION. None of them
       touch the DOM.
     • render() blows away #app entirely, then restores the drafts
       and the caret. That draft/caret restoration is the single
       thing that makes a full-innerHTML rerender feel smooth
       instead of janky.
     • overlays live in a separate root, so a modal never triggers
       a page rerender.
     • events are 100% delegated on document. There is not one
       addEventListener per node anywhere in a list.
   ============================================================ */

(function () {
  'use strict';

  const { $, $$, esc, nl, replyHtml, ICONS, avatar, toast, modal, picker, confirm, closeOverlay } = window.GfUI;
  const C = window.GfConfig;
  const S = window.GfStore;

  /* ============================================================
     Module state
     ============================================================ */

  let page = 'chat';
  let booted = false;
  let sending = false;
  let streamText = '';
  let listening = false;
  let recognition = null;
  let voiceStopTimer = null;
  let abortCtl = null;
  const draftState = {};

  // ephemeral UI state — deliberately not persisted
  const U = {
    familyFilter: 'all',
    memTab: 'facts',
    cloneFiles: [],
    cloneSource: '',
    cloneParticipants: [],
    cloneHer: '',
    cloneBusy: false,
    cloneStatus: '',
    authMode: 'in',
    authPhone: '',
    settingsTab: 'you',
    models: null,
    modelsBusy: false,
    companionSearch: '',
  };

  const NAV = [
    ['chat', 'Chat'],
    ['companions', 'Companions'],
    ['clone', 'Clone Lab'],
    ['memory', 'Memory'],
    ['gallery', 'Gallery'],
    ['settings', 'Settings'],
  ];
  const MOBILE_NAV = [['chat', 'Chat'], ['companions', 'Companions'], ['clone', 'Clone Lab'], ['memory', 'Memory'], ['more', 'More']];

  const isAdminUser = () => {
    try { return !!(window.GfAccess && (GfAccess.isAdmin() || GfAdmin.isLocalAdmin())); }
    catch (_) { return false; }
  };

  /* ============================================================
     SHELL
     ============================================================ */

  function navButton(id, label, mobile = false) {
    const active = page === id || (id === 'more' && !NAV.some(([n]) => n === page));
    return `<button class="${mobile ? '' : 'nav__item'} ${active ? 'is-active' : ''}"
      data-nav="${id}" aria-label="${esc(label)}">${ICONS[id] || ICONS.more}<span>${esc(label)}</span></button>`;
  }

  function shell(content) {
    const st = S.store;
    const admin = isAdminUser();
    const name = st.account.name
      || (st.account.phone ? GfCloud.prettyPhone(st.account.phone) : '')
      || 'You';
    const initials = admin ? '★'
      : (String(name).trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase() || '?');
    /* The admin account is a command centre, not a companion account —
       it gets the panel and nothing else, exactly like NutriWeb. */
    const nav = admin ? [['admin', 'Admin']] : NAV;
    const dark = st.settings.theme === 'dark';

    return `<div class="app-shell">
      <aside class="rail">
        <div class="brand"><span class="brand__mark">♥</span><span>Aria OS</span></div>
        ${admin ? '' : `<button class="newchat" data-action="new-companion">${ICONS.plus} New companion</button>`}
        <nav class="nav" aria-label="Primary">${nav.map(([id, l]) => navButton(id, l)).join('')}</nav>
        <div class="rail__bottom">
          <div class="themeswitch" data-action="toggle-theme" role="switch"
               aria-checked="${dark}" aria-label="Dark mode" tabindex="0">
            <span class="themeswitch__label">${ICONS.sun}<span>Light</span></span>
            <span class="themeswitch__label">${ICONS.moon}<span>Dark</span></span>
            <span class="themeswitch__knob"></span>
          </div>
          <div class="user-chip">
            <div class="avatar">${esc(initials)}</div>
            <div class="user-chip__meta">
              <div class="user-chip__name">${esc(name)}</div>
              <div class="user-chip__role">${
                admin ? 'Administrator'
                  : GfAccess.isCloud() ? (st.account.phone ? 'Signed in' : 'Cloud account')
                  : 'This device only'
              }</div>
            </div>
            ${GfAccess.isCloud() ? `<button class="iconbtn" data-action="logout" aria-label="Sign out">${ICONS.logout}</button>` : ''}
          </div>
        </div>
      </aside>

      <header class="mobile-top">
        <div class="brand"><span class="brand__mark">♥</span><span>Aria OS</span></div>
        <div class="row row--tight">
          <button class="iconbtn" data-action="toggle-theme"
                  aria-label="${dark ? 'Switch to light mode' : 'Switch to dark mode'}">${dark ? ICONS.sun : ICONS.moon}</button>
          ${admin ? '' : `<button class="iconbtn" data-action="new-companion" aria-label="New companion">${ICONS.plus}</button>`}
          ${admin ? `<button class="iconbtn" data-action="logout" aria-label="Sign out">${ICONS.logout}</button>`
                  : `<button class="iconbtn" data-nav="settings" aria-label="Settings">${ICONS.settings}</button>`}
        </div>
      </header>

      <main class="main" id="mainContent" tabindex="-1">${content}</main>

      <nav class="bottom-nav ${admin ? 'bottom-nav--solo' : ''}" aria-label="Mobile navigation">
        ${(admin ? [['admin', 'Admin']] : MOBILE_NAV).map(([id, l]) => navButton(id, l, true)).join('')}
      </nav>
    </div>`;
  }

  /* ============================================================
     PAGE — chat
     ============================================================ */

  function renderChat() {
    const c = S.active();
    if (!c) return `<section class="page"><div class="empty"><strong>No companion yet</strong>
      Make one from the Companions page.</div></section>`;

    const mood = C.MOODS[c.mood] || C.MOODS[C.DEFAULT_MOOD];
    const messages = c.messages;

    let lastDay = '';
    const body = messages.map((m) => {
      const day = GfUI.dayLabel(m.at);
      const mark = day !== lastDay ? `<div class="daymark"><span>${esc(day)}</span></div>` : '';
      lastDay = day;
      return mark + messageHtml(m, c);
    }).join('');

    const welcome = messages.length ? '' : `
      <div class="empty" style="margin-top:30px">
        <strong>${esc(c.name)} is waiting</strong>
        ${esc(c.spec?.blurb || '')}<br>
        <span class="muted" style="font-size:12.5px">Say anything. She picks it up from there.</span>
      </div>`;

    const quick = (C.QUICK_REPLIES[c.mood] || []).map((q) =>
      `<button data-quick="${esc(q)}">${esc(q)}</button>`).join('');

    const moodChips = Object.entries(C.MOODS).map(([k, m]) =>
      `<button class="chip-btn ${k === 'spicy' ? 'chip-btn--hot' : ''} ${c.mood === k ? 'is-active' : ''}"
        data-mood="${k}">${m.emoji} ${esc(m.label)}</button>`).join('');

    return `<section class="page chat-stage">
      <div id="trialbanner"></div>

      <div class="session-top">
        ${avatar(c)}
        <div class="session-top__meta">
          <div class="session-top__name">${esc(c.name)}</div>
          <div class="session-top__status">
            <span class="dot ${sending ? 'dot--busy' : (window.GfApi.ready() ? '' : 'dot--off')}"></span>
            ${sending ? 'typing…' : (window.GfApi.ready() ? `${mood.emoji} ${esc(mood.label)}` : 'no AI key yet')}
          </div>
        </div>
        <div class="console">
          <button class="console__dial" data-picker="companion">Switch</button>
          <button class="console__dial" data-picker="mood">${mood.emoji} ${esc(mood.label)}</button>
        </div>
        <button class="iconbtn" data-action="chat-menu" aria-label="Chat options">${ICONS.more}</button>
      </div>

      <div class="transcript" id="transcript">
        ${welcome}${body}
        ${sending ? `<article class="msg msg--ai" id="streamingMessage">
          <div class="msg__who"><span class="msg__mark"></span>${esc(c.name)}</div>
          <div class="msg__body">${streamText ? nl(streamText) : '<span class="typing"><i></i><i></i><i></i></span>'}</div>
        </article>` : ''}
      </div>

      <button class="jump" id="jumpBtn" data-action="scroll-down">${ICONS.down} New</button>

      <div class="composer-wrap">
        <div class="moodbar">${moodChips}</div>
        ${messages.length < 3 ? `<div class="quickreplies">${quick}</div>` : ''}
        <form class="composer" id="composerForm">
          <textarea id="composerInput" name="text" rows="1"
            placeholder="${esc(C.MOOD_PLACEHOLDER[c.mood] || 'say something…')}"></textarea>
          <div class="composer__row">
            <div class="composer__tools">
              <button type="button" class="iconbtn" data-action="voice-input" aria-label="Speak">${ICONS.mic}</button>
              <button type="button" class="iconbtn" data-action="make-image" aria-label="Ask for a picture">${ICONS.image}</button>
              <button type="button" class="iconbtn" data-action="attach" aria-label="Attach a file">${ICONS.attach}</button>
            </div>
            ${sending
              ? `<button class="send" type="button" data-action="stop" aria-label="Stop">${ICONS.stop}</button>`
              : `<button class="send" type="submit" aria-label="Send">${ICONS.send}</button>`}
          </div>
        </form>
      </div>
    </section>`;
  }

  function messageHtml(m, c) {
    if (m.imageId) {
      const img = S.getImage(m.imageId);
      return `<article class="msg ${m.role === 'user' ? 'msg--me' : 'msg--ai'}" data-mid="${esc(m.id)}">
        <div class="msg__who">${m.role === 'user' ? 'You' : `<span class="msg__mark"></span>${esc(c.name)}`}</div>
        ${img ? `<img class="msg__img" alt="${esc(m.content || 'picture')}" src="data:${esc(img.mime)};base64,${img.b64}">`
              : '<div class="msg__body muted">that picture is gone</div>'}
        ${m.content ? `<div class="msg__body" style="margin-top:8px">${nl(m.content)}</div>` : ''}
        <div class="msg__time">${GfUI.clock(m.at)}</div>
      </article>`;
    }

    const hot = m.role === 'assistant' && m.mood === 'spicy';
    return `<article class="msg ${m.role === 'user' ? 'msg--me' : 'msg--ai'} ${hot ? 'is-hot' : ''}" data-mid="${esc(m.id)}">
      <div class="msg__who">${m.role === 'user' ? 'You' : `<span class="msg__mark"></span>${esc(c.name)}`}</div>
      <div class="msg__body">${m.role === 'assistant' ? replyHtml(m.content) : nl(m.content)}</div>
      <div class="msg__time">${GfUI.clock(m.at)}</div>
      <div class="msg__actions">
        <button class="msg__action" data-action="copy-msg" data-mid="${esc(m.id)}">Copy</button>
        ${m.role === 'assistant' ? `<button class="msg__action" data-action="regen" data-mid="${esc(m.id)}">Again</button>` : ''}
        <button class="msg__action" data-action="del-msg" data-mid="${esc(m.id)}">Delete</button>
      </div>
    </article>`;
  }

  /* ============================================================
     PAGE — companions
     ============================================================ */

  function renderCompanions() {
    const all = S.list();
    const hiddenIds = S.store.hidden || [];
    const needle = U.companionSearch.trim().toLowerCase();

    const filtered = all
      .filter((c) => U.familyFilter === 'all'
        || (U.familyFilter === 'custom' ? c.custom : c.family === U.familyFilter))
      .filter((c) => !needle
        || `${c.name} ${c.spec?.label || ''} ${c.spec?.blurb || ''}`.toLowerCase().includes(needle));

    /* only offer a family filter when somebody is actually in it — with three
       built-ins, five empty chips would be noise */
    const populated = new Set(all.map((c) => c.family));
    const families = [['all', `✨ Everyone (${all.length})`]]
      .concat(C.FAMILIES.filter((f) => populated.has(f.key)).map((f) => [f.key, `${f.emoji} ${f.label}`]))
      .concat(all.some((c) => c.custom) ? [['custom', '🧬 Yours']] : []);

    const cards = filtered.map((c) => {
      const last = c.messages[c.messages.length - 1];
      return `<article class="gf-card ${c.id === S.store.activeId ? 'is-active' : ''}" data-open="${esc(c.id)}">
        <div class="gf-card__top">
          ${avatar(c)}
          <div style="min-width:0;flex:1">
            <div class="gf-card__name">${esc(c.name)}</div>
            <div class="gf-card__kind">${esc(c.spec?.label || 'Companion')}</div>
          </div>
          ${c.custom ? '<span class="pill pill--hot">yours</span>' : ''}
        </div>
        <p class="gf-card__tell">${esc(c.spec?.tell || c.spec?.blurb || '')}</p>
        <div class="gf-card__row">
          ${last ? `<span class="tag">${esc(GfUI.ago(last.at))} · ${c.messages.length} msgs</span>` : '<span class="tag">no chats yet</span>'}
          ${c.clonedFrom ? '<span class="tag">🧬 cloned</span>' : ''}
        </div>
        <div class="row row--tight" style="margin-top:6px">
          <button class="btn btn--small" data-action="open-companion" data-id="${esc(c.id)}">Open chat</button>
          <button class="iconbtn" data-action="edit-companion" data-id="${esc(c.id)}" aria-label="Edit">${ICONS.refine}</button>
          <button class="iconbtn iconbtn--danger" data-action="del-companion" data-id="${esc(c.id)}" aria-label="Remove">${ICONS.trash}</button>
        </div>
      </article>`;
    }).join('') || '<div class="empty"><strong>Nobody here</strong>Try a different filter.</div>';

    const hidden = hiddenIds.length ? `
      <div class="card card--flat" style="margin-top:18px">
        <h2>Hidden</h2>
        <p class="muted">Built-in personalities you removed. Nothing was deleted.</p>
        <div class="chips" style="margin-top:12px">
          ${hiddenIds.map((id) => {
            const p = C.byId(id);
            return p ? `<button class="chip-btn" data-action="restore-companion" data-id="${esc(id)}">${p.emoji} ${esc(p.defaultName)} · restore</button>` : '';
          }).join('')}
        </div>
      </div>` : '';

    return `<section class="page">
      <div id="trialbanner"></div>
      <div class="page-head">
        <div>
          <p class="eyebrow">Companions</p>
          <h1>Three to start with. Add as many as you like.</h1>
          <p>Each one keeps her own chat, her own mood and her own memory of you —
             nothing crosses over. Build one from scratch, or clone one from a real chat.</p>
        </div>
        <div class="row row--tight">
          <button class="btn btn--soft" data-nav="clone">🧬 Clone from a chat</button>
          <button class="btn" data-action="new-companion">${ICONS.plus} Build one</button>
        </div>
      </div>

      <div class="chips" style="margin-bottom:14px">
        ${families.map(([k, l]) => `<button class="chip-btn ${U.familyFilter === k ? 'is-active' : ''}" data-family="${k}">${esc(l)}</button>`).join('')}
      </div>
      <div class="field" style="max-width:340px">
        <input class="input" id="companionSearch" placeholder="Search…" value="${esc(U.companionSearch)}">
      </div>

      <div class="gf-grid">${cards}</div>
      ${hidden}
    </section>`;
  }

  /* ============================================================
     PAGE — Clone Lab
     ============================================================ */

  function renderClone() {
    const clones = S.store.clones || [];

    const partPicker = U.cloneParticipants.length >= 2 ? `
      <div class="field">
        <label>Which one is her?</label>
        <div class="chips">
          ${U.cloneParticipants.map((p) => `
            <button class="chip-btn ${U.cloneHer === p.name ? 'is-active' : ''}" data-cloneher="${esc(p.name)}">
              ${esc(p.name)} · ${p.count}
            </button>`).join('')}
        </div>
        <span class="hint">Pick the person whose voice you want. The other side is read as you.</span>
      </div>` : '';

    const files = U.cloneFiles.length
      ? `<div style="margin-bottom:12px">${U.cloneFiles.map((f) => `<span class="srcpill">📄 ${esc(f)}</span>`).join('')}</div>`
      : '';

    const list = clones.map((cl) => {
      const gf = S.store.companions[cl.companionId];
      return `<div class="memory-item">
        <div class="memory-item__text">
          <strong>${esc(cl.name)}</strong>
          ${cl.confidence ? `<span class="pill" style="margin-left:6px">${esc(String(cl.confidence).split('—')[0].trim())}</span>` : ''}
          <div class="muted" style="margin-top:4px">${esc(cl.summary || '')}</div>
          <div class="mono" style="margin-top:6px">${cl.hadSource ? 'from a real chat' : 'from a name only'} · ${GfUI.ago(cl.createdAt)}</div>
        </div>
        <div class="row row--tight">
          ${gf ? `<button class="btn btn--small" data-action="open-companion" data-id="${esc(gf.id)}">Talk</button>` : ''}
          <button class="iconbtn" data-action="inspect-clone" data-id="${esc(cl.id)}" aria-label="Inspect">${ICONS.eye}</button>
          <button class="iconbtn iconbtn--danger" data-action="del-clone" data-id="${esc(cl.id)}" aria-label="Delete">${ICONS.trash}</button>
        </div>
      </div>`;
    }).join('') || '<div class="empty"><strong>No clones yet</strong>Paste a real conversation on the left and she gets built from it.</div>';

    return `<section class="page">
      <div id="trialbanner"></div>
      <div class="page-head">
        <div>
          <p class="eyebrow">Clone Lab</p>
          <h1>Give it a chat. Get her back.</h1>
          <p>Export a WhatsApp conversation, paste it in, and it studies how she actually
             texts — her rhythm, her emoji, her pet names, how she flirts, how she fights,
             how she apologises — then builds a companion who does the same.</p>
        </div>
      </div>

      <div class="clone-grid">
        <section class="card">
          <h2>Build from a conversation</h2>

          <div class="import-box">
            <strong style="font-size:13.5px">How to export from WhatsApp</strong>
            <p class="muted" style="margin:6px 0 0;font-size:12.5px">
              Open the chat → ⋮ → More → Export chat → <em>Without media</em> → send it to yourself,
              then paste the .txt here or attach it below. iPhone, Android and desktop exports all work.
            </p>
          </div>

          <div class="field">
            <label for="cloneName">Her name (optional)</label>
            <input class="input" id="cloneName" placeholder="leave blank and it reads the name out of the chat">
          </div>

          <div class="field">
            <label for="cloneSource">Paste the conversation</label>
            <textarea class="input textarea" id="cloneSource" style="min-height:180px"
              placeholder="[12/03/2024, 10:22 pm] Simran: kahan ho tum&#10;[12/03/2024, 10:24 pm] Me: bas aa raha hu&#10;…">${esc(U.cloneSource)}</textarea>
            <span class="hint">The more real messages, the closer the clone. A few hundred is plenty.</span>
          </div>

          ${files}
          ${partPicker}

          <div class="field">
            <label for="cloneNote">Anything else worth knowing (optional)</label>
            <input class="input" id="cloneNote" placeholder="she's from Lucknow, we met at work, she calls me 'bandar'">
          </div>

          <div class="btnrow">
            <button class="btn btn--soft" data-action="clone-attach">📎 Attach files</button>
            <button class="btn btn--hot" data-action="build-clone" ${U.cloneBusy ? 'disabled' : ''}>
              ${U.cloneBusy ? 'Studying…' : 'Study and build her'}
            </button>
          </div>
          <p class="mono" id="cloneStatus" style="margin-top:10px">${esc(U.cloneStatus)}</p>
          ${U.cloneBusy ? '<div class="progbar" style="margin-top:8px"></div>' : ''}

          <p class="muted" style="font-size:12.5px;margin-top:14px">
            Two passes: first how she communicates, then a full personality spec.
            Accepts TXT, MD, CSV, JSON, PDF and SRT/VTT.
            It builds an archetype <em>in the style of</em> — it never claims to be that
            person and never invents quotes from them.
          </p>
        </section>

        <section class="card card--flat">
          <h2>Your clones</h2>
          ${list}
        </section>
      </div>
    </section>`;
  }

  /* ============================================================
     PAGE — memory
     ============================================================ */

  function renderMemory() {
    const c = S.active();
    if (!c) return '<section class="page"><div class="empty">No companion selected.</div></section>';
    const m = GfMemory.memOf(c);
    const tabs = [['facts', `Things she knows (${m.facts.length})`],
      ['pending', `Waiting for you (${m.pending.length})`],
      ['moments', `Moments (${m.moments.length})`]];

    let body = '';
    if (U.memTab === 'facts') {
      body = m.facts.map((f) => `<div class="memory-item">
        <button class="iconbtn" data-action="pin-fact" data-id="${esc(f.id)}"
          aria-label="Pin" style="${f.pinned ? 'color:var(--red)' : ''}">${ICONS.pin}</button>
        <div class="memory-item__text">${esc(f.text)}
          <div class="mono" style="margin-top:4px">${f.source === 'her' ? 'she noticed' : 'you told her'} · ${GfUI.ago(f.createdAt)}</div>
        </div>
        <button class="iconbtn iconbtn--danger" data-action="del-fact" data-id="${esc(f.id)}" aria-label="Forget">${ICONS.trash}</button>
      </div>`).join('') || '<div class="empty"><strong>Nothing yet</strong>She picks things up as you talk.</div>';
    } else if (U.memTab === 'pending') {
      body = (m.pending.length ? `<div class="row row--tight" style="margin-bottom:12px">
          <button class="btn btn--small" data-action="approve-all">${ICONS.check} Keep all</button>
          <button class="btn btn--small btn--soft" data-action="reject-all">Discard all</button>
        </div>` : '')
        + (m.pending.map((f) => `<div class="memory-item">
          <div class="memory-item__text">${esc(f.text)}</div>
          <button class="iconbtn" data-action="approve-fact" data-id="${esc(f.id)}" aria-label="Keep">${ICONS.check}</button>
          <button class="iconbtn iconbtn--danger" data-action="reject-fact" data-id="${esc(f.id)}" aria-label="Discard">${ICONS.close}</button>
        </div>`).join('') || '<div class="empty"><strong>Nothing waiting</strong>Anything she notices lands here first. She never decides on her own that she knows something about you.</div>');
    } else {
      body = m.moments.slice().reverse().map((mo) => `<div class="memory-item">
        <div class="memory-item__text">${esc(mo.text)}
          <div class="mono" style="margin-top:4px">${GfUI.ago(mo.at)}</div></div>
        <button class="iconbtn iconbtn--danger" data-action="del-moment" data-id="${esc(mo.id)}" aria-label="Forget">${ICONS.trash}</button>
      </div>`).join('') || '<div class="empty"><strong>No moments yet</strong>The ones that matter get kept here.</div>';
    }

    return `<section class="page">
      <div id="trialbanner"></div>
      <div class="page-head">
        <div>
          <p class="eyebrow">${esc(c.name)}</p>
          <h1>What she remembers</h1>
          <p>Every companion keeps her own memory. Nothing here is shared with the others,
             and nothing is sent anywhere except into her own prompt.</p>
        </div>
        <button class="btn btn--danger btn--small" data-action="forget-all">Forget everything</button>
      </div>

      ${m.summary ? `<div class="notice" style="margin-bottom:16px"><strong>Where things stand:</strong> ${esc(m.summary)}</div>` : ''}

      <div class="tabs">${tabs.map(([k, l]) =>
        `<button class="tab ${U.memTab === k ? 'is-active' : ''}" data-memtab="${k}">${esc(l)}</button>`).join('')}</div>

      <div class="card card--flat">
        ${U.memTab === 'facts' ? `<form id="factForm" class="row row--tight" style="margin-bottom:16px">
          <input class="input" name="text" placeholder="Tell her something to remember…" style="flex:1">
          <button class="btn" type="submit">Add</button>
        </form>` : ''}
        ${body}
      </div>
    </section>`;
  }

  /* ============================================================
     PAGE — gallery
     ============================================================ */

  function renderGallery() {
    const g = (S.store.gallery || []).slice().reverse();
    const items = g.map((item) => {
      const img = S.getImage(item.id);
      if (!img) return '';
      return `<figure>
        <img src="data:${esc(img.mime)};base64,${img.b64}" alt="${esc(item.prompt)}" loading="lazy">
        <figcaption>${esc(String(item.prompt).slice(0, 120))}
          <div class="row row--tight" style="margin-top:6px">
            <button class="btn btn--small btn--soft" data-action="save-image" data-id="${esc(item.id)}">Save</button>
            <button class="iconbtn iconbtn--danger" data-action="del-image" data-id="${esc(item.id)}">${ICONS.trash}</button>
          </div>
        </figcaption>
      </figure>`;
    }).join('') || `<div class="empty"><strong>No pictures yet</strong>
      Tap the picture icon in the chat and describe what you want to see.</div>`;

    return `<section class="page">
      <div id="trialbanner"></div>
      <div class="page-head">
        <div>
          <p class="eyebrow">Gallery</p>
          <h1>Pictures she made</h1>
          <p>Generated with Gemini. They live on this device only — the last ${24} are kept.</p>
        </div>
        <button class="btn" data-action="make-image">${ICONS.image} Make one</button>
      </div>
      <div class="gallery">${items}</div>
    </section>`;
  }

  /* ============================================================
     PAGE — settings
     ============================================================ */

  function renderSettings() {
    const st = S.store;
    const s = st.settings;
    const cloud = GfAccess.isCloud();
    const ann = s._announcement;

    const seg = (label, key, opts) => `
      <div class="field">
        <label>${esc(label)}</label>
        <div class="seg">${opts.map(([v, l]) =>
          `<button type="button" class="${s[key] === v ? 'on' : ''}" data-set="${key}" data-value="${v}">${esc(l)}</button>`).join('')}</div>
      </div>`;

    const toggle = (label, key, hint) => `
      <div class="row row--between" style="margin:14px 0">
        <div style="max-width:74%">
          <strong style="font-size:14px">${esc(label)}</strong>
          ${hint ? `<p class="muted" style="margin:3px 0 0;font-size:12.5px">${esc(hint)}</p>` : ''}
        </div>
        <button class="switch ${s[key] ? 'on' : ''}" data-toggle="${key}" aria-label="${esc(label)}"></button>
      </div>`;

    /* the provider card only appears when there is no cloud — in cloud mode
       the admin hands the keys down and there is nothing here to set */
    /* In cloud mode a user has NO API surface at all — no provider, no key,
       no model, no test button. The admin loads the keys centrally and they
       arrive at runtime. All the user ever sees is whether it is working. */
    const providerCard = cloud ? `
        <h2>AI</h2>
        <div class="row row--tight" style="margin:10px 0 2px">
          <span class="dot ${window.GfApi.ready() ? '' : 'dot--off'}"></span>
          <strong style="font-size:14px">${window.GfApi.ready() ? 'Ready' : 'Not available yet'}</strong>
        </div>
        <p class="muted" style="font-size:12.5px;margin:6px 0 0">${
          window.GfApi.ready()
            ? 'Everything is set up for you. There is nothing here to configure.'
            : (GfAccess.hasAccess()
                ? 'The AI has not been switched on yet. Try again shortly.'
                : 'Your access has run out — redeem a code below to switch it back on.')
        }</p>`
    : `
        <h2>Your API key</h2>
        <p class="muted">Running without a cloud, so bring your own. Nothing leaves this
          browser except the calls you configure here.</p>
        <div class="field" style="margin-top:14px">
          <label for="setProvider">Provider</label>
          <select class="select" id="setProvider" data-set-select="provider">
            ${C.PROVIDER_ORDER.map((p) => `<option value="${p}" ${s.provider === p ? 'selected' : ''}>${C.PROVIDERS[p].icon} ${C.PROVIDERS[p].label}</option>`).join('')}
          </select>
          <span class="hint">${esc(C.PROVIDERS[s.provider]?.keyHint || '')}</span>
        </div>
        ${s.provider === 'custom' ? `<div class="field">
          <label for="setEndpoint">Endpoint</label>
          <input class="input mono" id="setEndpoint" data-set-input="customEndpoint"
            value="${esc(s.customEndpoint)}" placeholder="https://host/v1/chat/completions">
        </div>` : ''}
        <div class="field">
          <label for="setKey">API key</label>
          <input class="input mono" id="setKey" type="password" data-set-input="apiKey"
            value="${esc(s.apiKey)}" autocomplete="off" spellcheck="false">
        </div>
        <div class="field">
          <label for="setModel">Model</label>
          ${U.models
            ? `<select class="select" id="setModel" data-set-select="model">
                ${U.models.map((m) => `<option value="${esc(m.id)}" ${s.model === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}
              </select>`
            : `<input class="input mono" id="setModel" data-set-input="model" value="${esc(s.model)}">`}
        </div>
        <div class="btnrow">
          <button class="btn btn--soft" data-action="load-models" ${U.modelsBusy ? 'disabled' : ''}>
            ${U.modelsBusy ? 'Loading…' : 'Load the model list'}
          </button>
          <button class="btn" data-action="test-key">⚡ Test connection</button>
        </div>
        <div class="field" style="margin-top:16px">
          <label for="setGemini">Gemini key, for pictures (optional)</label>
          <input class="input mono" id="setGemini" type="password" data-set-input="geminiKey"
            value="${esc(s.geminiKey)}" placeholder="AIza…">
          <span class="hint">Not needed if Gemini is already your chat provider.</span>
        </div>`;

    const planCard = cloud ? `
        <h2>Your plan</h2>
        <div class="prow"><span class="pl">Status</span><span class="pv">${esc(GfAccess.statusLine())}</span></div>
        <div class="prow"><span class="pl">Signed in as</span><span class="pv mono">${esc(GfCloud.prettyPhone(st.account.phone || ''))}</span></div>
        ${GfAccess.get()?.coupon_used ? `<div class="prow"><span class="pl">Coupon used</span><span class="pv mono">${esc(GfAccess.get().coupon_used)}</span></div>` : ''}
        <div class="btnrow" style="margin-top:14px">
          <button class="btn btn--hot" data-action="coupon">🎟️ Redeem a code</button>
          <button class="btn btn--soft" data-action="change-password">Change password</button>
          <button class="btn btn--soft" data-action="logout">Sign out</button>
        </div>` : '';

    return `<section class="page">
      <div id="trialbanner"></div>
      <div class="page-head">
        <div><p class="eyebrow">Settings</p><h1>How she talks, and who runs this</h1></div>
      </div>

      ${ann ? `<div class="notice" style="margin-bottom:16px"><strong>From the team:</strong> ${esc(ann)}</div>` : ''}

      <div class="grid">
        <div class="card card--6">
          <h2>You</h2>
          <div class="field">
            <label for="setName">What she calls you</label>
            <input class="input" id="setName" data-set-account="name" value="${esc(st.account.name)}" placeholder="your name">
          </div>
          ${seg('Language', 'language', [['en', 'English'], ['hi', 'Hindi'], ['mix', 'Hinglish']])}
          ${seg('How she addresses you', 'tone', [['aap', 'aap'], ['tum', 'tum'], ['tu', 'tu']])}
          ${seg('How much she argues', 'pushback', [['soft', 'Easy'], ['balanced', 'Balanced'], ['stubborn', 'Stubborn']])}
        </div>

        <div class="card card--6">
          <h2>Behaviour</h2>
          ${toggle('Adult mode', 'nsfw', 'Off caps every companion at flirty, no matter which mood you pick.')}
          ${toggle('Let her remember things', 'autoMemory', 'She proposes; you approve. Nothing is kept without you.')}
          ${toggle('Stream her replies', 'streaming', 'Words appear as she types them instead of landing all at once.')}
          ${toggle('Typing pause', 'typingDelay', 'A short human-sized pause before her reply appears.')}
          ${toggle('Read her replies aloud', 'autoSpeak', 'Uses your browser voice. No extra key.')}
        </div>

        <div class="card card--6">${providerCard}</div>
        ${planCard ? `<div class="card card--6">${planCard}</div>` : ''}

        <div class="card card--6">
          <h2>Look</h2>
          <div class="row row--between" style="margin:14px 0">
            <div style="max-width:74%">
              <strong style="font-size:14px">Dark mode</strong>
              <p class="muted" style="margin:3px 0 0;font-size:12.5px">Also on the sidebar, and on the
                <kbd>D</kbd> key when you're not typing.</p>
            </div>
            <button class="switch ${s.theme === 'dark' ? 'on' : ''}" data-action="toggle-theme" aria-label="Dark mode"></button>
          </div>
          ${seg('Skin', 'skin', [['brand', 'Navy & Red'], ['aurora', 'Aurora']])}
        </div>

        <div class="card card--6">
          <h2>Your data</h2>
          <p class="muted">Everything lives in this browser. Back it up before you clear site data.</p>
          <div class="btnrow" style="margin-top:14px">
            <button class="btn btn--soft" data-action="export">Export a backup</button>
            <button class="btn btn--soft" data-action="import">Restore a backup</button>
          </div>
          <hr class="divider">
          <button class="btn btn--danger btn--wide" data-action="wipe">Delete everything on this device</button>
        </div>
      </div>
    </section>`;
  }

  /* ============================================================
     PAGE — admin (mount point; GfAdmin fills it)
     ============================================================ */

  function renderAdmin() {
    return `<section class="page">
      <div class="page-head">
        <div><p class="eyebrow">Admin</p><h1>Access, coupons, keys and personalities</h1></div>
        <button class="btn btn--soft btn--small" data-action="admin-reload">⟳ Refresh</button>
      </div>
      <div id="adminHost"></div>
    </section>`;
  }

  /* ============================================================
     AUTH (cloud mode only)
     ============================================================ */

  function renderAuth() {
    const mode = U.authMode;                    // 'in' | 'up'
    const up = mode === 'up';
    return `<div class="gate-root" style="position:relative;min-height:100vh">
      <section class="gate-card">
        <div class="brand" style="padding:0 0 16px"><span class="brand__mark">♥</span><span>Aria OS</span></div>
        <h2>${up ? 'Make an account' : 'Welcome back'}</h2>
        <p class="muted" style="font-size:13px;margin:6px 0 20px">
          ${up
            ? 'Your number and a password. Nothing else — no email, no code to wait for.'
            : 'Sign in once and this device stays signed in.'}
        </p>

        <form id="authForm" autocomplete="on">
          <div class="field">
            <label for="auPhone">Mobile number</label>
            <div class="phonefield">
              <span class="phonefield__cc">+91</span>
              <input class="input mono" id="auPhone" name="phone" type="tel" inputmode="numeric"
                     placeholder="98739 93559" required autocomplete="username"
                     maxlength="15" value="${esc(U.authPhone || '')}">
            </div>
          </div>

          ${up ? `<div class="field">
            <label for="auName">What should she call you?</label>
            <input class="input" id="auName" name="name" autocomplete="name" placeholder="optional">
          </div>` : ''}

          <div class="field">
            <label for="auPass">Password</label>
            <div style="position:relative">
              <input class="input" id="auPass" name="password" type="password" required minlength="6"
                     autocomplete="${up ? 'new-password' : 'current-password'}"
                     placeholder="${up ? 'at least 6 characters' : ''}" style="padding-right:46px">
              <button type="button" class="iconbtn" data-action="toggle-pass" aria-label="Show or hide password"
                      style="position:absolute;right:6px;top:50%;transform:translateY(-50%)">${ICONS.eye || '👁'}</button>
            </div>
          </div>

          <button class="btn btn--hot btn--wide" type="submit" id="authGo">
            ${up ? 'Create my account' : 'Sign in'}
          </button>
          ${up ? '' : '<p class="muted" style="font-size:11.5px;text-align:center;margin:10px 0 0">Forgot your password? Ask the admin — they can restore your access and you can set a new one once you\'re back in.</p>'}
          <p class="gate-msg" id="authError"></p>
        </form>

        <hr class="divider">
        <button class="btn btn--small btn--soft btn--wide" data-authmode="${up ? 'in' : 'up'}">
          ${up ? 'I already have an account' : "I'm new — make me an account"}
        </button>
        <p class="muted" style="font-size:11.5px;text-align:center;margin:14px 0 0;line-height:1.5">
          New accounts get a free trial. 18+ only.
        </p>
      </section>
    </div>`;
  }

  function renderAgeGate() {
    return `<div class="gate-root" style="position:relative;min-height:100vh">
      <section class="gate-card">
        <div class="brand" style="padding:0 0 14px"><span class="brand__mark">♥</span><span>Aria OS</span></div>
        <h2>Adults only</h2>
        <p class="muted" style="font-size:13.5px;line-height:1.6;margin:8px 0 20px">
          This is a private companion app for adults. Conversations here can be explicit.
          By continuing you confirm you are 18 or older and that you understand every
          character in it is fictional.
        </p>
        <button class="btn btn--hot btn--wide" data-action="age-ok">I'm 18 or older</button>
        <p class="gate-msg">Everything you type stays in this browser, and in whichever
          AI provider is configured.</p>
      </section>
    </div>`;
  }

  /* ============================================================
     RENDER
     ============================================================ */

  const VIEWS = {
    chat: renderChat,
    companions: renderCompanions,
    clone: renderClone,
    memory: renderMemory,
    gallery: renderGallery,
    settings: renderSettings,
    admin: renderAdmin,
  };

  const DRAFT_IDS = ['composerInput', 'cloneSource', 'cloneName', 'cloneNote', 'companionSearch'];

  function render() {
    if (!booted) return;

    if (!localStorage.getItem(C.AGE_KEY)) { $('#app').innerHTML = renderAgeGate(); return; }
    if (GfAccess.isCloud() && !GfCloud.currentUser()) { $('#app').innerHTML = renderAuth(); return; }
    if (!S.ready) return;

    S.applyChrome();

    // 1 · snapshot named drafts
    DRAFT_IDS.forEach((id) => {
      const n = $('#' + id);
      if (n) draftState[id] = { value: n.value, start: n.selectionStart, end: n.selectionEnd };
    });

    // 2 · snapshot the focused field generically
    const a = document.activeElement;
    const focused = a?.matches?.('input,textarea,select')
      ? { id: a.id, name: a.name, value: a.value, start: a.selectionStart, end: a.selectionEnd }
      : null;

    // 3 · full re-render — the admin is pinned to the panel
    if (isAdminUser()) page = 'admin';
    $('#app').innerHTML = shell((VIEWS[page] || renderChat)());

    // 4 · after
    if (page === 'admin') { try { GfAdmin.render(); } catch (e) { console.warn(e); } }
    try { GfGate.paintBanner(); } catch (_) {}
    GfUI.setupReveals(page);

    // 5 · restore drafts, then focus and caret
    Object.entries(draftState).forEach(([id, state]) => {
      const n = $('#' + id);
      if (n && state && n.value !== state.value) n.value = state.value;
    });
    if (focused) {
      const sel = focused.id ? `#${CSS.escape(focused.id)}` : `[name="${CSS.escape(focused.name || '')}"]`;
      const n = $(sel);
      if (n) {
        if (n.value !== focused.value) n.value = focused.value;
        n.focus({ preventScroll: true });
        if (typeof n.setSelectionRange === 'function' && focused.start != null) {
          try { n.setSelectionRange(focused.start, focused.end); } catch (_) {}
        }
      }
    }

    if (page === 'chat') {
      autoResize();
      requestAnimationFrame(() => scrollDown(false));
    }
  }

  function go(next) {
    if (next === 'more') { openMorePicker(); return; }
    if (isAdminUser() && next !== 'admin') return;   // the admin has one screen
    page = next;
    render();
    window.scrollTo({ top: 0 });
  }

  /* ============================================================
     CHAT BEHAVIOUR
     ============================================================ */

  function scrollDown(smooth = true) {
    const t = $('#transcript');
    if (!t) return;
    window.scrollTo({ top: document.body.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  function autoResize() {
    const el = $('#composerInput');
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 170) + 'px';
  }

  function humanDelay(text) {
    if (!S.store.settings.typingDelay) return 0;
    const n = String(text || '').length;
    return Math.min(2200, 350 + n * 12);
  }

  function keyMissing() {
    if (window.GfApi.ready()) return false;
    toast(GfAccess.isCloud()
      ? 'No AI key has been set up yet. Ask the admin.'
      : 'Add your API key in Settings first.');
    go('settings');
    return true;
  }

  async function send(preset) {
    if (sending) return;
    const c = S.active();
    if (!c) return;

    const input = $('#composerInput');
    const text = (preset != null ? preset : (input?.value || '')).trim();
    if (!text) return;
    if (keyMissing()) return;

    if (input && preset == null) { input.value = ''; delete draftState.composerInput; autoResize(); }

    S.pushMessage(c.id, 'user', text);
    await requestReply(c);
  }

  /* Ask her for a reply to whatever the conversation currently is. Used by
     send() and by "Again", which rewinds the transcript first and adds no
     new user turn of its own. */
  async function requestReply(c) {
    if (sending) return;
    sending = true;
    streamText = '';
    render();

    abortCtl = new AbortController();
    let reply = '';
    try {
      reply = await window.GfApi.chat(c, {
        signal: abortCtl.signal,
        onToken: (tok) => {
          streamText += tok;
          const body = $('#streamingMessage .msg__body');
          if (body) { body.textContent = streamText; scrollDown(false); }
        },
      });
    } catch (e) {
      sending = false;
      abortCtl = null;
      if (e.name === 'AbortError') { streamText = ''; render(); return; }
      S.pushMessage(c.id, 'assistant', `⚠️ ${e.message}`, { error: true });
      render();
      return;
    }

    const wait = streamText ? 0 : humanDelay(reply);
    if (wait) await new Promise((r) => setTimeout(r, wait));

    sending = false;
    abortCtl = null;
    streamText = '';
    S.pushMessage(c.id, 'assistant', reply, { mood: c.mood });
    render();

    if (S.store.settings.autoSpeak) speak(reply);
    GfMemory.maybeExtract(c).then((r) => {
      if (r && r.added) render();
    }).catch(() => {});
  }

  async function regenerate(mid) {
    if (sending) return;
    const c = S.active();
    const idx = c.messages.findIndex((m) => m.id === mid);
    if (idx < 0) return;
    if (keyMissing()) return;
    c.messages = c.messages.slice(0, idx);   // drop that reply and anything after it
    S.saveNow();
    await requestReply(c);
  }

  function speak(text) {
    try {
      if (!window.speechSynthesis) return;
      const u = new SpeechSynthesisUtterance(String(text).slice(0, 500));
      u.lang = S.store.settings.ttsLang === 'hi' ? 'hi-IN' : 'en-IN';
      u.rate = 1.02;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch (_) {}
  }

  /* ---------- voice input ---------- */

  function stopVoice() {
    listening = false;
    clearTimeout(voiceStopTimer);
    try { recognition?.stop(); } catch (_) {}
    $$('[data-action="voice-input"]').forEach((b) => b.classList.remove('is-listening'));
  }

  function toggleVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast('Voice input is not supported in this browser.'); return; }
    if (listening) { stopVoice(); toast('Stopped listening.'); return; }

    const target = $('#composerInput');
    const base = target && target.value ? target.value.trim() + ' ' : '';
    recognition = new SR();
    recognition.lang = S.store.settings.voiceLang || 'en-IN';
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.maxAlternatives = 1;

    let finalText = '';
    listening = true;
    $$('[data-action="voice-input"]').forEach((b) => b.classList.add('is-listening'));

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) finalText += r[0].transcript.trim() + ' ';
        else interim += r[0].transcript;
      }
      if (target) { target.value = (base + finalText + interim).replace(/\s+/g, ' ').trim(); autoResize(); }
      clearTimeout(voiceStopTimer);
      voiceStopTimer = setTimeout(() => { if (listening) { stopVoice(); toast('Finished listening.'); } }, 9000);
    };
    recognition.onend = () => {
      // Chrome cuts the session off after ~60s; restart while we still want it
      if (listening) { try { recognition.start(); return; } catch (_) {} }
      stopVoice();
    };
    recognition.onerror = (event) => {
      if (event.error === 'no-speech') return;
      stopVoice();
      toast(`Voice input stopped: ${event.error}`);
    };
    try { recognition.start(); } catch (_) { stopVoice(); }
  }

  /* ---------- pictures ---------- */

  function askForImage() {
    const c = S.active();
    if (!window.GfApi.imageAvailable()) {
      toast('Pictures need a Gemini key. Ask the admin, or add one in Settings.');
      return;
    }
    modal('Make a picture', `
      <div class="field">
        <label for="imgPrompt">What do you want to see?</label>
        <textarea class="input textarea" id="imgPrompt" style="min-height:110px"
          placeholder="her in the kitchen at midnight, warm light, phone in hand"></textarea>
        <span class="hint">Made with Gemini, and kept on this device only.</span>
      </div>
      <button class="btn btn--hot btn--wide" id="imgGo">Make it</button>
      <p class="gate-msg" id="imgMsg"></p>`);

    setTimeout(() => {
      const go2 = $('#imgGo');
      if (!go2) return;
      go2.onclick = async () => {
        const p = ($('#imgPrompt').value || '').trim();
        if (!p) return;
        go2.disabled = true; go2.textContent = 'Making it…';
        try {
          const styled = `A photorealistic portrait. ${p}. Cinematic warm light, shallow depth of field, natural skin texture, 85mm lens. Subject is an adult woman.`;
          const { image, text } = await window.GfApi.generateImage(styled);
          if (!image) throw new Error(text || 'Nothing came back.');
          const id = S.putImage(p, image.mimeType || image.mime_type || 'image/png', image.data);
          S.pushMessage(c.id, 'assistant', text || '', { imageId: id });
          closeOverlay();
          go('chat');
          toast('Made it 🖼️');
        } catch (e) {
          $('#imgMsg').textContent = e.message;
          go2.disabled = false; go2.textContent = 'Make it';
        }
      };
      $('#imgPrompt')?.focus();
    }, 30);
  }

  /* ============================================================
     PICKERS AND EDITORS
     ============================================================ */

  function openCompanionPicker() {
    const all = S.list();
    picker('Who are you talking to?', all.map((c, i) => ({
      value: c.id,
      label: c.name,
      emoji: c.emoji,
      preview: c.spec?.tell || c.spec?.blurb || '',
      index: i + 1,
      selected: c.id === S.store.activeId,
      editId: c.id,
    })), `<button class="btn btn--small btn--soft" data-action="new-companion">＋ Build a new one</button>
          <button class="btn btn--small btn--soft" data-nav="clone">🧬 Clone from a chat</button>`);
  }

  function openMoodPicker() {
    const c = S.active();
    picker('How is she feeling?', Object.entries(C.MOODS).map(([k, m], i) => ({
      value: 'mood:' + k,
      label: m.label,
      emoji: m.emoji,
      preview: m.desc,
      index: i + 1,
      selected: c.mood === k,
    })));
  }

  function openMorePicker() {
    const extra = [['gallery', 'Gallery'], ['settings', 'Settings']]
      .concat(isAdminUser() ? [['admin', 'Admin']] : []);
    picker('More', extra.map(([id, label], i) => ({
      value: 'nav:' + id, label, index: i + 1, selected: page === id,
    })));
  }

  const SPEC_FIELDS = [
    ['label', 'Personality title', 'e.g. Soft & Stubborn'],
    ['blurb', 'One-line description', 'what a user reads in the list'],
    ['tradition', 'Where she comes from', 'the kind of person she is'],
    ['register', 'How she sounds', 'warm, blunt, playful, exacting…'],
    ['rhythm', 'How she texts', 'message length, pacing, punctuation'],
    ['opens_with', 'Opens with', 'her first move in any conversation'],
    ['moves', 'Signature moves', 'the things she always does'],
    ['lexicon', 'Words she uses', 'comma separated'],
    ['refuses', 'Refuses', 'what she will never do'],
    ['closes_with', 'Closes with', 'how she ends a message'],
    ['spice', 'When it gets spicy', 'exactly how she behaves, in her own voice'],
    ['tell', 'A line only she would send', ''],
  ];

  function openCompanionEditor(id) {
    const c = id ? S.store.companions[id] : null;
    const spec = c?.spec || {};
    modal(c ? `Edit ${c.name}` : 'Build a companion', `
      <form id="companionForm" data-id="${esc(id || '')}">
        <div class="grid2">
          <div class="field">
            <label for="cfName">Her name</label>
            <input class="input" id="cfName" name="name" value="${esc(c?.name || '')}" required>
          </div>
          <div class="field">
            <label for="cfEmoji">Emoji</label>
            <input class="input" id="cfEmoji" name="emoji" value="${esc(c?.emoji || '💜')}" maxlength="4">
          </div>
        </div>
        <div class="field">
          <label for="cfFamily">Family</label>
          <select class="select" id="cfFamily" name="family">
            ${C.FAMILIES.map((f) => `<option value="${f.key}" ${(c?.family || 'romance') === f.key ? 'selected' : ''}>${f.emoji} ${f.label}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="cfImg">Avatar image (optional)</label>
          <input class="input mono" id="cfImg" name="avatarImg" value="${esc(c?.avatarImg || '')}"
            placeholder="assets/avatars/her.png">
          <span class="hint">Drop a file into <code>assets/avatars/</code> and put its path here.</span>
        </div>
        <hr class="divider">
        ${SPEC_FIELDS.map(([k, label, ph]) => `
          <div class="field">
            <label for="cf_${k}">${esc(label)}</label>
            <textarea class="input textarea" id="cf_${k}" name="${k}" rows="2"
              style="min-height:${k === 'moves' || k === 'spice' ? '90px' : '58px'}"
              placeholder="${esc(ph)}">${esc(spec[k] || '')}</textarea>
          </div>`).join('')}
        <div class="field">
          <label for="cfPrompt">Full system prompt override (advanced)</label>
          <textarea class="input textarea" id="cfPrompt" name="systemPrompt" rows="4"
            placeholder="leave empty to build the prompt from the fields above">${esc(c?.systemPrompt || '')}</textarea>
          <span class="hint">Use <code>{name}</code> for her and <code>{username}</code> for you.</span>
        </div>
        <div class="btnrow" style="margin-top:8px">
          <button class="btn btn--soft" type="button" data-action="close-overlay">Cancel</button>
          ${c ? `<button class="btn btn--soft" type="button" data-action="view-prompt" data-id="${esc(c.id)}">See her prompt</button>` : ''}
          <button class="btn btn--hot" type="submit">${c ? 'Save' : 'Create her'}</button>
        </div>
      </form>`, { wide: true });
  }

  function inspectClone(id) {
    const cl = S.store.clones.find((x) => x.id === id);
    if (!cl) return;
    const A = cl.analysis || {};
    const rows = Object.entries(A)
      .filter(([, v]) => v && typeof v !== 'object')
      .map(([k, v]) => `<div class="mech"><div class="mech__k">${esc(k.replace(/_/g, ' '))}</div>
        <div class="mech__v">${esc(v)}</div></div>`).join('');
    const samples = (A.sample_lines || []).map((l) => `<div class="mech"><div class="mech__k">sample</div>
      <div class="mech__v"><em>${esc(l)}</em></div></div>`).join('');
    modal(`How ${cl.name} talks`, `
      <p class="muted" style="margin-bottom:14px">${esc(cl.summary || '')}</p>
      ${rows}${samples}
      <div class="btnrow" style="margin-top:16px">
        <button class="btn btn--soft" data-action="refine-clone" data-id="${esc(cl.id)}">Feed it more chat</button>
      </div>`, { wide: true });
  }

  function refineClone(id) {
    const cl = S.store.clones.find((x) => x.id === id);
    if (!cl) return;
    modal(`Refine ${cl.name}`, `
      <p class="muted">Paste more of the same conversation. Her spec gets sharpened, never replaced.</p>
      <div class="field" style="margin-top:12px">
        <textarea class="input textarea" id="refineSrc" style="min-height:180px"
          placeholder="paste more messages…"></textarea>
      </div>
      <button class="btn btn--hot btn--wide" id="refineGo">Refine her</button>
      <p class="gate-msg" id="refineMsg"></p>`);
    setTimeout(() => {
      const b = $('#refineGo');
      if (!b) return;
      b.onclick = async () => {
        const src = ($('#refineSrc').value || '').trim();
        if (src.length < 100) { $('#refineMsg').textContent = 'Paste a bit more than that.'; return; }
        b.disabled = true; b.textContent = 'Reading…';
        try {
          await GfClone.refine(cl.companionId, src, (m) => { $('#refineMsg').textContent = m; });
          closeOverlay();
          toast('She got sharper 🧬');
          render();
        } catch (e) {
          $('#refineMsg').textContent = e.message;
          b.disabled = false; b.textContent = 'Refine her';
        }
      };
    }, 30);
  }

  function viewPrompt(id) {
    const c = S.store.companions[id] || S.active();
    const text = window.GfApi.buildSystemPrompt(c);
    modal(`${c.name}'s full prompt`, `
      <p class="muted">This is exactly what the model receives, layers and all.</p>
      <pre style="white-space:pre-wrap;font-family:var(--f-mono);font-size:12px;line-height:1.5;
        background:var(--sheet);padding:16px;border-radius:14px;max-height:52vh;overflow:auto;margin-top:12px">${esc(text)}</pre>`,
      { wide: true });
  }

  /* ============================================================
     CLONE LAB behaviour
     ============================================================ */

  function refreshCloneParticipants() {
    const src = ($('#cloneSource')?.value || '').trim();
    U.cloneSource = src;
    if (src.length < 80) { U.cloneParticipants = []; return; }
    const parsed = GfClone.parseChat(src);
    const before = U.cloneParticipants.map((p) => p.name).join('|');
    U.cloneParticipants = parsed.participants.slice(0, 6);
    if (!U.cloneHer && U.cloneParticipants.length) U.cloneHer = U.cloneParticipants[0].name;
    if (before !== U.cloneParticipants.map((p) => p.name).join('|')) render();
  }

  async function buildClone() {
    if (U.cloneBusy) return;
    const source = ($('#cloneSource')?.value || '').trim();
    const name = ($('#cloneName')?.value || '').trim();
    const note = ($('#cloneNote')?.value || '').trim();

    if (!window.GfApi.ready()) { toast('No AI key is set up yet.'); return; }
    if (!source && !name) { toast('Paste a conversation, or at least give her a name.'); return; }

    U.cloneBusy = true;
    U.cloneStatus = 'Starting…';
    render();

    try {
      const { companion } = await GfClone.build({
        name, source, note,
        herName: U.cloneHer,
        emoji: '🧬',
        onStatus: (m) => {
          U.cloneStatus = m;
          const el = $('#cloneStatus');
          if (el) el.textContent = m;
        },
      });
      U.cloneBusy = false;
      U.cloneStatus = '';
      U.cloneSource = '';
      U.cloneHer = '';
      U.cloneParticipants = [];
      U.cloneFiles = [];
      delete draftState.cloneSource;
      delete draftState.cloneName;
      delete draftState.cloneNote;
      toast(`${companion.name} is ready 🧬`);
      go('chat');
    } catch (e) {
      U.cloneBusy = false;
      U.cloneStatus = e.message;
      render();
      toast(e.message);
    }
  }

  /* ============================================================
     EVENTS — all delegated on document
     ============================================================ */

  document.addEventListener('click', async (event) => {
    // overlay dismissal
    if (event.target.classList?.contains('modal-backdrop') || event.target.classList?.contains('picker-backdrop')) {
      closeOverlay();
      return;
    }

    const nav = event.target.closest('[data-nav]');
    if (nav) { go(nav.dataset.nav); return; }

    const pick = event.target.closest('[data-pick-value]');
    if (pick) {
      const v = pick.dataset.pickValue;
      closeOverlay();
      if (v.startsWith('mood:')) {
        const c = S.active();
        c.mood = v.slice(5);
        S.saveNow();
        page = 'chat';
      } else if (v.startsWith('nav:')) {
        page = v.slice(4);
      } else {
        S.setActive(v);
        page = 'chat';
      }
      render();
      return;
    }

    const pk = event.target.closest('[data-picker]');
    if (pk) {
      if (pk.dataset.picker === 'companion') openCompanionPicker();
      if (pk.dataset.picker === 'mood') openMoodPicker();
      return;
    }

    const moodChip = event.target.closest('[data-mood]');
    if (moodChip) {
      const c = S.active();
      c.mood = moodChip.dataset.mood;
      S.saveNow();
      render();
      return;
    }

    const fam = event.target.closest('[data-family]');
    if (fam) { U.familyFilter = fam.dataset.family; render(); return; }

    const mt = event.target.closest('[data-memtab]');
    if (mt) { U.memTab = mt.dataset.memtab; render(); return; }

    const quick = event.target.closest('[data-quick]');
    if (quick) { send(quick.dataset.quick); return; }

    const openCard = event.target.closest('[data-open]');
    if (openCard && !event.target.closest('[data-action]')) {
      S.setActive(openCard.dataset.open);
      go('chat');
      return;
    }

    const her = event.target.closest('[data-cloneher]');
    if (her) { U.cloneHer = her.dataset.cloneher; render(); return; }

    const am = event.target.closest('[data-authmode]');
    if (am) { U.authMode = am.dataset.authmode; render(); return; }

    const setBtn = event.target.closest('[data-set]');
    if (setBtn) {
      S.store.settings[setBtn.dataset.set] = setBtn.dataset.value;
      S.saveNow();
      render();
      return;
    }

    const tog = event.target.closest('[data-toggle]');
    if (tog) {
      const k = tog.dataset.toggle;
      S.store.settings[k] = !S.store.settings[k];
      S.saveNow();
      render();
      return;
    }

    const action = event.target.closest('[data-action]');
    if (!action) return;
    const name = action.dataset.action;
    const id = action.dataset.id;

    try {
      switch (name) {
        case 'close-overlay': closeOverlay(); break;
        case 'age-ok':
          localStorage.setItem(C.AGE_KEY, '1');
          render();
          break;
        case 'toggle-pass': {
          const p = $('#auPass');
          if (p) { p.type = p.type === 'password' ? 'text' : 'password'; p.focus(); }
          break;
        }

        case 'toggle-theme': {
          const s2 = S.store.settings;
          s2.theme = s2.theme === 'dark' ? 'light' : 'dark';
          S.applyChrome();                 // flip instantly, before the rerender
          S.saveNow();
          render();
          break;
        }
        case 'scroll-down': scrollDown(); break;
        case 'stop': window.GfApi.stop(); abortCtl?.abort(); break;
        case 'voice-input': toggleVoice(); break;
        case 'make-image': askForImage(); break;
        case 'attach': $('#fileInput').click(); break;

        case 'copy-msg': {
          const c = S.active();
          const m = c.messages.find((x) => x.id === action.dataset.mid);
          if (m) { await navigator.clipboard.writeText(m.content); toast('Copied'); }
          break;
        }
        case 'del-msg':
          S.removeMessage(S.store.activeId, action.dataset.mid);
          render();
          break;
        case 'regen': regenerate(action.dataset.mid); break;

        case 'chat-menu': {
          const c = S.active();
          modal(c.name, `
            <div class="stack">
              <button class="btn btn--soft btn--wide" data-action="view-prompt" data-id="${esc(c.id)}">See her full prompt</button>
              <button class="btn btn--soft btn--wide" data-action="edit-companion" data-id="${esc(c.id)}">Edit her personality</button>
              <button class="btn btn--soft btn--wide" data-nav="memory">What she remembers</button>
              <button class="btn btn--danger btn--wide" data-action="clear-chat" data-id="${esc(c.id)}">Clear this chat</button>
            </div>`);
          break;
        }
        case 'clear-chat':
          confirm({
            title: 'Clear this chat?',
            body: 'The messages go. What she remembers about you stays.',
            confirmText: 'Clear it',
            onConfirm: () => { S.resetChat(id); closeOverlay(); render(); },
          });
          break;

        case 'new-companion': closeOverlay(); openCompanionEditor(null); break;
        case 'edit-companion': closeOverlay(); openCompanionEditor(id); break;
        case 'open-companion': S.setActive(id); go('chat'); break;
        case 'view-prompt': viewPrompt(id); break;
        case 'restore-companion': S.restoreCompanion(id); render(); break;
        case 'del-companion': {
          const c = S.store.companions[id];
          confirm({
            title: c.custom ? `Delete ${c.name}?` : `Hide ${c.name}?`,
            body: c.custom
              ? 'She and everything you said to her are gone for good.'
              : 'She disappears from your list. Nothing is deleted — restore her any time.',
            confirmText: c.custom ? 'Delete her' : 'Hide her',
            onConfirm: () => { S.removeCompanion(id); render(); },
          });
          break;
        }

        case 'clone-attach': {
          const input = $('#fileInput');
          input.dataset.target = 'clone';
          input.click();
          break;
        }
        case 'build-clone': buildClone(); break;
        case 'inspect-clone': inspectClone(id); break;
        case 'refine-clone': closeOverlay(); refineClone(id); break;
        case 'del-clone':
          confirm({
            title: 'Delete this clone?',
            body: 'The analysis goes. The companion herself stays until you delete her too.',
            confirmText: 'Delete',
            onConfirm: () => {
              S.store.clones = S.store.clones.filter((x) => x.id !== id);
              S.saveNow();
              render();
            },
          });
          break;

        case 'pin-fact': GfMemory.togglePin(id); render(); break;
        case 'del-fact': GfMemory.deleteFact(id); render(); break;
        case 'del-moment': GfMemory.deleteMoment(id); render(); break;
        case 'approve-fact': GfMemory.approve(id); render(); break;
        case 'reject-fact': GfMemory.reject(id); render(); break;
        case 'approve-all': GfMemory.approveAll(); render(); break;
        case 'reject-all': GfMemory.rejectAll(); render(); break;
        case 'forget-all':
          confirm({
            title: 'Forget everything?',
            body: `${S.active().name} loses every fact and every moment she was holding onto. The chat itself stays.`,
            confirmText: 'Forget it all',
            onConfirm: () => { GfMemory.forgetEverything(); render(); },
          });
          break;

        case 'save-image': {
          const img = S.getImage(id);
          if (!img) break;
          const a2 = document.createElement('a');
          a2.href = `data:${img.mime};base64,${img.b64}`;
          a2.download = `aria-${id}.png`;
          a2.click();
          break;
        }
        case 'del-image': S.removeImage(id); render(); break;

        case 'load-models': {
          U.modelsBusy = true; render();
          try {
            U.models = await window.GfApi.listModels({});
            const s = S.store.settings;
            if (!U.models.some((m) => m.id === s.model)) {
              s.model = window.GfApi.pickBestModel(s.provider, U.models);
            }
            S.saveNow();
            toast(`${U.models.length} models`);
          } catch (e) { toast(e.message); }
          U.modelsBusy = false; render();
          break;
        }
        case 'test-key': {
          const s = S.store.settings;
          toast('Testing…');
          const r = await window.GfApi.testKey(s.provider, window.GfApi.currentKey(), s.model);
          toast((r.ok ? '✅ ' : '❌ ') + r.message);
          break;
        }

        case 'coupon': GfGate.couponSheet(); break;
        case 'change-password':
          modal('Change your password', `
            <div class="field">
              <label for="pwNew">New password</label>
              <input class="input" id="pwNew" type="password" minlength="6" placeholder="at least 6 characters">
            </div>
            <button class="btn btn--hot btn--wide" id="pwGo">Save it</button>
            <p class="gate-msg" id="pwMsg"></p>`);
          setTimeout(() => {
            const b = $('#pwGo');
            if (!b) return;
            b.onclick = async () => {
              const v = $('#pwNew').value;
              b.disabled = true; b.textContent = 'Saving…';
              try {
                await GfCloud.updatePassword(v);
                closeOverlay();
                toast('Password changed.');
              } catch (e2) {
                $('#pwMsg').textContent = e2.message;
                b.disabled = false; b.textContent = 'Save it';
              }
            };
            $('#pwNew')?.focus();
          }, 30);
          break;
        case 'admin-reload': GfAdmin.reload(); break;

        case 'logout':
          confirm({
            title: 'Sign out?',
            body: 'Your chats stay on this device and sync back when you return.',
            confirmText: 'Sign out',
            danger: false,
            onConfirm: async () => {
              S.saveNow();
              try { await GfCloud.signOut(); } catch (_) {}
              location.reload();
            },
          });
          break;

        case 'export': {
          const payload = S.exportAll(false);
          const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
          const a3 = document.createElement('a');
          a3.href = URL.createObjectURL(blob);
          a3.download = `aria-os-backup-${GfUI.dateKey()}.json`;
          a3.click();
          setTimeout(() => URL.revokeObjectURL(a3.href), 1000);
          toast('Backup saved (keys left out on purpose)');
          break;
        }
        case 'import': {
          const input = $('#fileInput');
          input.dataset.target = 'import';
          input.click();
          break;
        }
        case 'wipe':
          confirm({
            title: 'Delete everything?',
            body: 'Every chat, every memory, every picture on this device. There is no undo.',
            confirmText: 'Delete it all',
            onConfirm: () => { S.wipe(); page = 'chat'; render(); toast('Wiped.'); },
          });
          break;

        default: break;
      }
    } catch (e) {
      console.warn(e);
      toast(e.message || 'Something went wrong.');
    }
  });

  /* ---------- forms ---------- */

  document.addEventListener('submit', async (event) => {
    const form = event.target;
    event.preventDefault();

    try {
      if (form.id === 'composerForm') { send(); return; }

      if (form.id === 'factForm') {
        const text = new FormData(form).get('text');
        if (GfMemory.addFact(text)) { form.reset(); render(); }
        else toast('She already knows that one.');
        return;
      }

      if (form.id === 'companionForm') {
        const fd = new FormData(form);
        const id = form.dataset.id;
        const spec = {};
        SPEC_FIELDS.forEach(([k]) => { spec[k] = String(fd.get(k) || '').trim(); });
        const patch = {
          name: String(fd.get('name') || '').trim().slice(0, 40),
          emoji: String(fd.get('emoji') || '💜').trim().slice(0, 4),
          family: String(fd.get('family') || 'romance'),
          avatarImg: String(fd.get('avatarImg') || '').trim(),
          systemPrompt: String(fd.get('systemPrompt') || '').trim(),
          spec,
        };
        if (!patch.name) throw new Error('Give her a name.');
        if (id) S.updateCompanion(id, patch);
        else {
          const gf = S.createCompanion(patch);
          S.setActive(gf.id);
        }
        closeOverlay();
        render();
        toast('Saved. She is live in every new message.');
        return;
      }

      if (form.id === 'authForm') {
        const fd = new FormData(form);
        const phone = String(fd.get('phone') || '').trim();
        const password = String(fd.get('password') || '');
        const nm = String(fd.get('name') || '').trim();
        const err = $('#authError');
        const go = $('#authGo');

        U.authPhone = phone;
        if (err) err.textContent = '';
        if (go) { go.disabled = true; go.textContent = 'Working…'; }

        try {
          if (U.authMode === 'up') await GfCloud.signUpPhone(phone, password, nm);
          else await GfCloud.signInPhone(phone, password);
          // onCloudAuth takes it from here
        } finally {
          if (go && document.contains(go)) {
            go.disabled = false;
            go.textContent = U.authMode === 'up' ? 'Create my account' : 'Sign in';
          }
        }
        return;
      }
    } catch (e) {
      const err = $('#authError');
      if (err) err.textContent = e.message;
      else toast(e.message);
    }
  });

  /* ---------- input / change ---------- */

  const debouncedClone = GfUI.debounce(refreshCloneParticipants, 500);

  document.addEventListener('input', (event) => {
    const t = event.target;
    if (t.id === 'composerInput') { autoResize(); return; }
    if (t.id === 'cloneSource') { debouncedClone(); return; }
    if (t.id === 'companionSearch') {
      U.companionSearch = t.value;
      clearTimeout(window.__searchT);
      window.__searchT = setTimeout(() => render(), 260);
      return;
    }
    if (t.dataset.setInput) {
      S.store.settings[t.dataset.setInput] = t.value;
      if (t.dataset.setInput === 'apiKey') {
        S.store.settings.apiKeys[S.store.settings.provider] = t.value;
        window.GfKey.v = '';
      }
      S.save();
      return;
    }
    if (t.dataset.setAccount) {
      S.store.account[t.dataset.setAccount] = t.value;
      S.save();
    }
  });

  document.addEventListener('change', async (event) => {
    const t = event.target;

    if (t.dataset.setSelect) {
      const k = t.dataset.setSelect;
      S.store.settings[k] = t.value;
      if (k === 'provider') {
        U.models = null;
        S.store.settings.model = C.DEFAULT_MODEL_FOR(t.value);
        S.store.settings.apiKey = S.store.settings.apiKeys[t.value] || '';
      }
      S.saveNow();
      render();
      return;
    }

    if (t.id === 'fileInput') {
      const target = t.dataset.target || 'chat';
      const files = [...(t.files || [])];
      t.value = '';
      delete t.dataset.target;
      if (!files.length) return;

      if (target === 'import') {
        try {
          const text = await files[0].text();
          S.importAll(JSON.parse(text));
          render();
          toast('Backup restored.');
        } catch (e) { toast(e.message); }
        return;
      }

      if (target === 'clone') {
        try {
          U.cloneStatus = 'Reading files…';
          render();
          const { text, names } = await GfClone.readFiles(files, (m) => {
            U.cloneStatus = m;
            const el = $('#cloneStatus');
            if (el) el.textContent = m;
          });
          U.cloneFiles = names;
          const box = $('#cloneSource');
          if (box) { box.value = (box.value + '\n\n' + text).trim(); draftState.cloneSource = { value: box.value }; }
          U.cloneStatus = `${names.length} file(s) added.`;
          refreshCloneParticipants();
          render();
        } catch (e) { U.cloneStatus = e.message; render(); toast(e.message); }
        return;
      }

      // chat attachment — plain text into the composer, clearly fenced
      const box = $('#composerInput');
      if (!box) return;
      for (const f of files) {
        if (f.size > 2_000_000) { toast(`${f.name} is too big to attach.`); continue; }
        if (!/\.(txt|md|json|csv|srt|vtt)$/i.test(f.name)) { toast(`${f.name} is not a text file.`); continue; }
        const text = await f.text();
        box.value += `\n\n<attached_file name="${f.name.replace(/["><]/g, '')}">\n${text.slice(0, 12000)}\n</attached_file>`;
      }
      autoResize();
      box.focus();
    }
  });

  /* ---------- keys ---------- */

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeOverlay(); return; }

    const typing = document.activeElement?.matches?.('input,textarea,select');

    if (event.target.id === 'composerInput' && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
      return;
    }
    if (typing) return;

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openCompanionPicker();
      return;
    }
    if (event.key.toLowerCase() === 'd' && !event.metaKey && !event.ctrlKey) {
      const s2 = S.store.settings;
      s2.theme = s2.theme === 'dark' ? 'light' : 'dark';
      S.applyChrome(); S.saveNow(); render();
      return;
    }
    if (event.key === '/') {
      const box = $('#composerInput');
      if (box) { event.preventDefault(); box.focus(); }
      return;
    }
    const n = parseInt(event.key, 10);
    if (n >= 1 && n <= 5 && !$('#overlayRoot').innerHTML) {
      const moods = Object.keys(C.MOODS);
      const c = S.active();
      if (c && moods[n - 1]) { c.mood = moods[n - 1]; S.saveNow(); render(); }
    }
  });

  /* ---------- scroll ---------- */

  window.addEventListener('scroll', () => {
    const jump = $('#jumpBtn');
    if (!jump) return;
    const near = window.innerHeight + window.scrollY >= document.body.scrollHeight - 220;
    jump.classList.toggle('on', !near && page === 'chat');
  }, { passive: true });

  window.addEventListener('beforeunload', () => { S.saveNow?.(); });

  /* ============================================================
     BOOT
     ============================================================ */

  async function onCloudAuth(user) {
    if (user) {
      const phone = GfCloud.emailToPhone(user.email);
      S.open(user.email, user.user_metadata?.name || '', phone);
      S.store.account.cloud = true;
      S.store.account.phone = phone;
      await refreshAccess(user.user_metadata?.name);
      const remote = await GfCloud.pull().catch(() => null);
      if (remote && remote.companions && Object.keys(remote.companions).length) {
        // remote wins only when this device has nothing yet
        const localMsgs = S.list().reduce((n, c) => n + c.messages.length, 0);
        if (!localMsgs) {
          try { S.importAll({ product: 'Aria OS', data: remote }); } catch (_) {}
        }
      }
      if (isAdminUser()) page = 'admin';
      booted = true;
      render();
    } else {
      window.GfKeys = [];
      window.GfKey = { v: '' };
      GfAccess.set(null);
      GfGate.hide();
      booted = true;
      render();
    }
  }

  async function refreshAccess(nameHint) {
    if (!window.GfAccess) return;
    try {
      await GfAccess.refresh(nameHint);
      await GfAccess.syncConfig();
      try { GfGate.enforce(); } catch (_) {}
      // global adult-mode kill switch from the admin
      const cfg = GfAccess.config();
      if (cfg && cfg.nsfw_enabled === false) S.store.settings.nsfw = false;
    } catch (e) { console.warn('access check failed', e); }
  }

  async function boot() {
    GfUI.startMotionLayer();

    if (GfCloud.configured()) {
      // wait for the session to restore, but never let a slow CDN block first paint
      const init = GfCloud.init(onCloudAuth);
      await Promise.race([init, new Promise((r) => setTimeout(r, 3500))]);
      const u = GfCloud.currentUser();
      if (u) { await onCloudAuth(u); }
      else { booted = true; render(); }
      GfAccess.startWatch();
    } else {
      S.open('local', '');
      booted = true;
      render();
    }

    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
  }

  window.GfApp = { render, go, send, boot, get page() { return page; } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
