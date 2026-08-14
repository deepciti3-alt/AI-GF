/* ============================================================
   memory.js — what makes her remember you.

   Three kinds of memory, per companion:
     facts    durable things about him — his people, his work,
              what he loves and hates, an inside joke
     moments  emotional highlights worth carrying forward
     summary  one rolling line about where things stand

   Every few of his messages we quietly ask the model to pull out
   anything new worth keeping, de-duplicate it against what she
   already knows, and fold it back into her system prompt so she
   brings it up on her own.

   New in this build: extraction proposes, it does not commit.
   Anything the model pulls out lands in `pending` and shows up in
   the Memory page for a one-tap approve or reject. She never
   silently decides she knows something about you.
   ============================================================ */

(function () {
  'use strict';

  const EXTRACT_EVERY = 3;      // his messages between extractions
  const MAX_FACTS = 60;
  const MAX_MOMENTS = 30;
  const FACTS_IN_PROMPT = 26;

  let extracting = false;

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  function similar(a, b) {
    const na = norm(a); const nb = norm(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (na.includes(nb) || nb.includes(na)) return true;
    const wa = new Set(na.split(' '));
    const wb = new Set(nb.split(' '));
    let shared = 0;
    wa.forEach((w) => { if (wb.has(w)) shared++; });
    return shared / Math.max(wa.size, wb.size) > 0.7;
  }

  const memOf = (c) => {
    const t = c || window.GfStore.active();
    if (!t) return null;
    if (!t.memory) t.memory = window.GfStore.freshMemory();
    if (!Array.isArray(t.memory.pending)) t.memory.pending = [];
    return t.memory;
  };

  /* ============================================================
     The block injected into her system prompt
     ============================================================ */

  function promptBlock(companion) {
    const m = memOf(companion);
    if (!m) return '';
    const pinned = m.facts.filter((f) => f.pinned);
    const rest = m.facts.filter((f) => !f.pinned);
    const facts = [...pinned, ...rest].slice(0, FACTS_IN_PROMPT);
    if (!facts.length && !m.summary && !m.moments.length) return '';

    let out = '\n\n── WHAT YOU REMEMBER ABOUT HIM ──';
    if (m.summary) out += `\nWhere things stand: ${m.summary}`;
    if (facts.length) out += '\nThings you know:\n' + facts.map((f) => `• ${f.text}`).join('\n');
    if (m.moments.length) {
      out += '\nMoments that stayed with you:\n'
        + m.moments.slice(-5).map((mo) => `• ${mo.text}`).join('\n');
    }
    out += '\nUse this the way a real partner would — bring it up when it fits, never recite it as a list, never announce that you remembered.';
    return out;
  }

  /* ============================================================
     Manual editing
     ============================================================ */

  function addFact(text, companion, category = 'note') {
    const m = memOf(companion);
    if (!m || !String(text).trim()) return false;
    if (m.facts.some((f) => similar(f.text, text))) return false;
    m.facts.unshift({
      id: uid(), text: String(text).trim(), category,
      createdAt: Date.now(), pinned: false, source: 'you',
    });
    m.facts = m.facts.slice(0, MAX_FACTS);
    window.GfStore.save();
    return true;
  }

  function deleteFact(id, companion) {
    const m = memOf(companion);
    m.facts = m.facts.filter((f) => f.id !== id);
    window.GfStore.save();
  }

  function togglePin(id, companion) {
    const m = memOf(companion);
    const f = m.facts.find((x) => x.id === id);
    if (f) { f.pinned = !f.pinned; window.GfStore.save(); }
  }

  function editFact(id, text, companion) {
    const m = memOf(companion);
    const f = m.facts.find((x) => x.id === id);
    if (f) { f.text = String(text).trim(); window.GfStore.save(); }
  }

  function deleteMoment(id, companion) {
    const m = memOf(companion);
    m.moments = m.moments.filter((x) => x.id !== id);
    window.GfStore.save();
  }

  function forgetEverything(companion) {
    const t = companion || window.GfStore.active();
    t.memory = window.GfStore.freshMemory();
    t.memory.pending = [];
    window.GfStore.save();
  }

  /* ---------- the approval queue ---------- */

  function approve(id, companion) {
    const m = memOf(companion);
    const p = m.pending.find((x) => x.id === id);
    if (!p) return;
    m.pending = m.pending.filter((x) => x.id !== id);
    if (!m.facts.some((f) => similar(f.text, p.text))) {
      m.facts.unshift({
        id: uid(), text: p.text, category: p.category || 'note',
        createdAt: Date.now(), pinned: false, source: 'her',
      });
      m.facts = m.facts.slice(0, MAX_FACTS);
    }
    window.GfStore.save();
  }

  function approveAll(companion) {
    const m = memOf(companion);
    [...m.pending].forEach((p) => approve(p.id, companion));
  }

  function reject(id, companion) {
    const m = memOf(companion);
    m.pending = m.pending.filter((x) => x.id !== id);
    window.GfStore.save();
  }

  function rejectAll(companion) {
    const m = memOf(companion);
    m.pending = [];
    window.GfStore.save();
  }

  function pendingCount(companion) {
    const m = memOf(companion);
    return m ? m.pending.length : 0;
  }

  /* ============================================================
     Automatic extraction
     ============================================================ */

  async function maybeExtract(companion) {
    const st = window.GfStore.store;
    const c = companion || window.GfStore.active();
    if (!st || !c) return null;
    if (st.settings.autoMemory === false) return null;
    if (extracting) return null;

    const m = memOf(c);
    const userTurns = c.messages.filter((x) => x.role === 'user').length;
    if (userTurns - (m.lastExtractedCount || 0) < EXTRACT_EVERY) return null;

    extracting = true;
    try {
      const recent = c.messages.slice(-14)
        .map((x) => `${x.role === 'user' ? 'HIM' : 'HER'}: ${x.content}`)
        .join('\n');
      const known = m.facts.slice(0, 24).map((f) => f.text).join('; ') || '(nothing yet)';

      const prompt =
`You maintain long-term memory for a companion named ${c.name}, about her partner.
Already known: ${known}

From the exchange below, extract ONLY genuinely new, durable things worth remembering about HIM — his life, work, preferences, people, plans, feelings, inside jokes. Skip small talk, skip anything already known, skip anything that will not matter next week. Note at most one emotionally significant MOMENT if one clearly happened. Keep a one-line summary of the relationship current.

Reply with strict JSON only. No prose, no markdown:
{"facts":["short third-person fact"],"moment":"one sentence or empty","summary":"one line or empty"}

EXCHANGE:
"""
${recent}
"""`;

      const raw = await window.GfApi.textTask(prompt, { max_tokens: 700, temperature: 0.2 });
      const parsed = window.GfApi.parseJsonObject(raw);

      let added = 0;
      (parsed.facts || []).slice(0, 8).forEach((text) => {
        const t = String(text || '').trim();
        if (!t || t.length < 4) return;
        if (m.facts.some((f) => similar(f.text, t))) return;
        if (m.pending.some((f) => similar(f.text, t))) return;
        m.pending.push({ id: uid(), text: t, category: 'note', at: Date.now() });
        added++;
      });

      const moment = String(parsed.moment || '').trim();
      if (moment && !m.moments.some((x) => similar(x.text, moment))) {
        m.moments.push({ id: uid(), text: moment, at: Date.now() });
        m.moments = m.moments.slice(-MAX_MOMENTS);
      }

      const summary = String(parsed.summary || '').trim();
      if (summary) m.summary = summary.slice(0, 260);

      m.lastExtractedCount = userTurns;
      window.GfStore.save();
      return { added, moment: !!moment };
    } catch (e) {
      console.warn('memory extraction failed', e);
      // do not retry on every single message after a failure
      memOf(c).lastExtractedCount = c.messages.filter((x) => x.role === 'user').length;
      return null;
    } finally {
      extracting = false;
    }
  }

  window.GfMemory = {
    promptBlock, addFact, deleteFact, editFact, togglePin, deleteMoment, forgetEverything,
    approve, approveAll, reject, rejectAll, pendingCount,
    maybeExtract, memOf, similar,
  };
})();
