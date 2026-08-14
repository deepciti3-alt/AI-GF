/* ============================================================
   ui.js — rendering primitives.  window.GfUI

   Everything in here is a pure helper: escaping, markdown, icons,
   toasts, modals, bottom-sheet pickers. No app state, no routing.
   app.js owns those.
   ============================================================ */

(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  /* ============================================================
     Escaping — every piece of user or model text goes through this
     before it reaches innerHTML. Escape first, parse second.
     ============================================================ */

  const esc = (v = '') => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  const nl = (v = '') => esc(v).replace(/\n/g, '<br>');

  /* ============================================================
     Markdown — dependency-free and safe, because esc() runs on the
     whole input before any parsing happens.
     ============================================================ */

  function inlineMd(v = '') {
    return v
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  function markdown(v = '') {
    const lines = esc(v).replace(/\r/g, '').split('\n');
    const out = [];
    let list = '';
    let inCode = false;
    let code = [];
    const closeList = () => { if (list) { out.push(`</${list}>`); list = ''; } };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (/^```/.test(line)) {
        closeList();
        if (inCode) { out.push(`<pre><code>${code.join('\n')}</code></pre>`); code = []; }
        inCode = !inCode;
        continue;
      }
      if (inCode) { code.push(line); continue; }

      // GFM table — header row plus a separator row on the next line
      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) {
        closeList();
        const headers = line.replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].includes('|')) {
          rows.push(lines[i].replace(/^\||\|$/g, '').split('|').map((x) => x.trim()));
          i++;
        }
        i--;
        out.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${
          headers.map((h) => `<th>${inlineMd(h)}</th>`).join('')
        }</tr></thead><tbody>${
          rows.map((row) => `<tr>${headers.map((_, n) => `<td>${inlineMd(row[n] || '')}</td>`).join('')}</tr>`).join('')
        }</tbody></table></div>`);
        continue;
      }

      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        closeList();
        out.push(`<h${heading[1].length}>${inlineMd(heading[2])}</h${heading[1].length}>`);
        continue;
      }

      const ul = line.match(/^\s*[-*]\s+(.+)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (ul || ol) {
        const next = ul ? 'ul' : 'ol';
        if (list !== next) { closeList(); list = next; out.push(`<${list}>`); }
        out.push(`<li>${inlineMd((ul || ol)[1])}</li>`);
        continue;
      }

      closeList();
      if (!line.trim()) continue;
      out.push(`<p>${inlineMd(line)}</p>`);
    }
    closeList();
    if (inCode) out.push(`<pre><code>${code.join('\n')}</code></pre>`);
    return out.join('');
  }

  /* Her replies are texts, not documents. Full markdown on a two-line
     WhatsApp message just mangles it, so only run the parser when the
     text actually looks structured. */
  function replyHtml(text) {
    const t = String(text || '');
    const structured = /(^|\n)\s*(#{1,3}\s|[-*]\s|\d+[.)]\s|```|\|)/.test(t) || t.length > 400;
    return structured ? markdown(t) : nl(t);
  }

  /* ============================================================
     Icons — stroke-based, 24×24, keys match nav ids
     ============================================================ */

  const ICONS = {
    chat:      '<svg class="icon" viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-6a8 8 0 0 1 8-8h2a8 8 0 0 1 8 3z"/></svg>',
    companions:'<svg class="icon" viewBox="0 0 24 24"><path d="M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 20v-2a4 4 0 0 0-3-3.9M16 3.1A4 4 0 0 1 16 11"/></svg>',
    clone:     '<svg class="icon" viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    memory:    '<svg class="icon" viewBox="0 0 24 24"><path d="M9 5a3 3 0 0 1 6 0v1a3 3 0 0 1 2 5 3 3 0 0 1-1 5 3 3 0 0 1-4 3 3 3 0 0 1-4-3 3 3 0 0 1-1-5 3 3 0 0 1 2-5zM12 5v14"/></svg>',
    gallery:   '<svg class="icon" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
    settings:  '<svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    admin:     '<svg class="icon" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    more:      '<svg class="icon" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
    send:      '<svg class="icon" viewBox="0 0 24 24"><path d="M5 12h14M14 7l5 5-5 5"/></svg>',
    mic:       '<svg class="icon" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></svg>',
    image:     '<svg class="icon" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
    attach:    '<svg class="icon" viewBox="0 0 24 24"><path d="M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L16 6"/></svg>',
    plus:      '<svg class="icon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    close:     '<svg class="icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    back:      '<svg class="icon" viewBox="0 0 24 24"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>',
    logout:    '<svg class="icon" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
    refine:    '<svg class="icon" viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    trash:     '<svg class="icon" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
    stop:      '<svg class="icon" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    down:      '<svg class="icon" viewBox="0 0 24 24"><path d="M12 5v14M5 12l7 7 7-7"/></svg>',
    eye:       '<svg class="icon" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    pin:       '<svg class="icon" viewBox="0 0 24 24"><path d="M12 17v5M5 9l7-7 7 7-2 2v4l2 3H3l2-3v-4z"/></svg>',
    check:     '<svg class="icon" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>',
    sun:       '<svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.4M12 19.6V22M2 12h2.4M19.6 12H22M4.9 4.9l1.7 1.7M17.4 17.4l1.7 1.7M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7"/></svg>',
    moon:      '<svg class="icon" viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>',
  };

  /* ============================================================
     Avatar
     ============================================================ */

  function avatar(c, cls = '') {
    if (!c) return `<div class="avatar ${cls}">?</div>`;
    if (c.avatarImg) {
      return `<div class="avatar ${cls}"><img src="${esc(c.avatarImg)}" alt="${esc(c.name)}"
        onerror="this.parentNode.textContent='${esc(c.emoji || '💜')}'"></div>`;
    }
    return `<div class="avatar avatar--hot ${cls}">${esc(c.emoji || '💜')}</div>`;
  }

  /* ============================================================
     Time
     ============================================================ */

  const dateKey = (d = new Date()) => new Intl.DateTimeFormat('en-CA').format(d);

  function clock(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function dayLabel(ts) {
    const d = new Date(ts);
    const today = dateKey();
    const yday = dateKey(new Date(Date.now() - 86400000));
    const k = dateKey(d);
    if (k === today) return 'Today';
    if (k === yday) return 'Yesterday';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }

  function ago(ts) {
    if (!ts) return '';
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    const d = Math.floor(hrs / 24);
    return d < 7 ? `${d}d` : dayLabel(ts);
  }

  /* ============================================================
     Toast
     ============================================================ */

  function toast(message, duration = 3400) {
    const region = $('#toasts');
    if (!region) { console.log(message); return; }
    const node = document.createElement('div');
    node.className = 'toast';
    node.textContent = String(message);
    region.append(node);
    setTimeout(() => node.remove(), duration);
  }

  /* ============================================================
     Overlays — modal, picker, confirm. One root, one dismissal path.
     ============================================================ */

  let overlayOnClose = null;

  function closeOverlay() {
    const root = $('#overlayRoot');
    if (root) root.innerHTML = '';
    const cb = overlayOnClose;
    overlayOnClose = null;
    if (cb) { try { cb(); } catch (_) {} }
  }

  function modal(title, bodyHtml, { wide = false, onClose = null } = {}) {
    overlayOnClose = onClose;
    $('#overlayRoot').innerHTML = `
      <div class="modal-backdrop" data-overlay-close="true">
        <section class="modal ${wide ? 'modal--wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
          <header class="modal__head">
            <h2>${esc(title)}</h2>
            <button class="iconbtn" data-action="close-overlay" aria-label="Close">${ICONS.close}</button>
          </header>
          <div class="modal__body">${bodyHtml}</div>
        </section>
      </div>`;
  }

  /* items: [{value,label,preview,index,selected,emoji,editId}] */
  function picker(title, items, footHtml = '') {
    $('#overlayRoot').innerHTML = `
      <div class="picker-backdrop" data-overlay-close="true">
        <section class="picker" role="dialog" aria-modal="true" aria-label="${esc(title)}">
          <div class="picker__grip"></div>
          <header class="picker__head">
            <h2>${esc(title)}</h2>
            <button class="iconbtn" data-action="close-overlay" aria-label="Close">${ICONS.close}</button>
          </header>
          <div class="picker__list">
            ${items.map((it, i) => `
              <div class="pick-row">
                <button class="pick ${it.selected ? 'is-selected' : ''}" data-pick-value="${esc(it.value)}">
                  <strong>${it.emoji ? esc(it.emoji) + ' ' : ''}${esc(it.label)}</strong>
                  <span class="pick__index">${String(it.index ?? i + 1).padStart(2, '0')}</span>
                  ${it.preview ? `<small>${esc(it.preview)}</small>` : ''}
                </button>
                ${it.editId ? `<button class="iconbtn" data-action="edit-companion" data-id="${esc(it.editId)}" title="Edit">${ICONS.refine}</button>` : ''}
              </div>`).join('')}
          </div>
          ${footHtml ? `<div class="picker__foot">${footHtml}</div>` : ''}
        </section>
      </div>`;
    $('.pick')?.focus();
  }

  function confirm({ title, body, confirmText = 'Confirm', danger = true, onConfirm }) {
    modal(title, `
      <p class="muted" style="line-height:1.55">${esc(body)}</p>
      <div class="btnrow" style="margin-top:20px">
        <button class="btn btn--soft" data-action="close-overlay">Cancel</button>
        <button class="btn ${danger ? 'btn--danger' : ''}" id="confirmGo">${esc(confirmText)}</button>
      </div>`);
    setTimeout(() => {
      const go = $('#confirmGo');
      if (go) go.onclick = () => { closeOverlay(); try { onConfirm?.(); } catch (e) { toast(e.message); } };
    }, 20);
  }

  /* ============================================================
     Scroll reveals + cursor glow (the Assistant motion layer)
     ============================================================ */

  let revealObserver = null;
  let lastRevealPage = null;

  function setupReveals(page) {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    if (page === lastRevealPage) return;
    lastRevealPage = page;
    revealObserver?.disconnect();
    revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add('in-view'); revealObserver.unobserve(e.target); }
      });
    }, { threshold: 0.08 });
    $$('.card,.gf-card,.memory-item,.urow').forEach((n) => {
      n.classList.add('reveal');
      revealObserver.observe(n);
    });
  }

  function startMotionLayer() {
    if (!window.matchMedia
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches
      || !window.matchMedia('(pointer: fine)').matches) return;
    const glow = $('#cursorGlow');
    document.addEventListener('pointermove', (event) => {
      document.body.classList.add('has-pointer');
      if (glow) { glow.style.left = `${event.clientX}px`; glow.style.top = `${event.clientY}px`; }
      document.documentElement.style.setProperty('--mx', (event.clientX / window.innerWidth - 0.5).toFixed(3));
      document.documentElement.style.setProperty('--my', (event.clientY / window.innerHeight - 0.5).toFixed(3));
    }, { passive: true });
    document.addEventListener('pointerleave', () => document.body.classList.remove('has-pointer'));
  }

  const debounce = (fn, wait = 250) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
  };

  window.GfUI = {
    $, $$, esc, nl, markdown, inlineMd, replyHtml,
    ICONS, avatar,
    dateKey, clock, dayLabel, ago,
    toast, modal, picker, confirm, closeOverlay,
    setupReveals, startMotionLayer, debounce,
  };
})();
