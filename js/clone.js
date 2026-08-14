/* ============================================================
   clone.js — the Clone Lab.

   Feed it a real chat and it builds a girlfriend who texts like
   the person in it.

   The pipeline:

     chat text / files / a bare name
            │
            ├── parseChat()          split into {who, text} turns,
            │                        detect the participants
            ├── pick "her"           the user chooses whose voice
            │                        to clone (defaults to whoever
            │                        is not him)
            ▼
     PASS 1  forensic texting analyst
            → JSON A: rhythm, emoji habits, pet names, Hinglish
              ratio, how she flirts / fights / apologises, how she
              opens, how she closes, how she escalates, real
              sample lines lifted as patterns
            ▼
     PASS 2  compile into a companion spec
            → JSON V: the same 11 fields every built-in
              personality has, so a cloned girl and a built-in
              girl are literally the same kind of object
            ▼
     merge V over A (V wins, A backfills) → createCompanion()

   Two deliberate rules, baked into the DATA rather than the
   prompt so they survive a prompt edit:
     • the clone is an archetype "in the style of", never a claim
       to be the real person
     • it never invents quotes and attributes them to them
   ============================================================ */

(function () {
  'use strict';

  const MAX_SOURCE = 26000;     // characters of chat fed to pass 1
  const MAX_FILE = 15 * 1024 * 1024;

  /* ============================================================
     1 · CHAT PARSING
     ============================================================ */

  /* WhatsApp exports come in a handful of shapes depending on phone,
     locale and year. These four cover essentially all of them. */
  const LINE_PATTERNS = [
    // [12/03/2023, 10:22:11 PM] Name: text        (iOS)
    /^\s*\[(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}),?\s+([\d:]+\s*(?:[APap]\.?[Mm]\.?)?)\]\s*([^:]{1,60}?):\s?([\s\S]*)$/,
    // 12/03/2023, 10:22 pm - Name: text           (Android)
    /^\s*(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}),?\s+([\d:]+\s*(?:[APap]\.?[Mm]\.?)?)\s*[-–]\s*([^:]{1,60}?):\s?([\s\S]*)$/,
    // Name (10:22): text                          (some exporters)
    /^\s*([^:(]{1,60}?)\s*\((\d{1,2}:\d{2}[^)]*)\):\s?([\s\S]*)$/,
  ];

  // pasted-by-hand chats: "Name: text" with no timestamp at all
  const BARE = /^\s*([A-Za-z][\w .'’-]{0,38}?):\s(.+)$/;

  const NOISE = /(end-to-end encrypted|messages and calls are|<media omitted>|image omitted|video omitted|sticker omitted|audio omitted|document omitted|this message was deleted|you deleted this message|created group|added you|joined using this group|changed the subject|changed this group|missed voice call|missed video call|null|^\s*<attached:)/i;

  function stripNoise(t) {
    const s = String(t || '').trim();
    if (!s) return '';
    if (NOISE.test(s)) return '';
    return s;
  }

  /* Returns { turns: [{who,text}], participants: [{name,count,chars}] } */
  function parseChat(raw) {
    const lines = String(raw || '').replace(/\r/g, '').split('\n');
    const turns = [];
    let matchedStructured = 0;

    for (const line of lines) {
      let who = null; let text = null;

      for (const re of LINE_PATTERNS) {
        const m = line.match(re);
        if (m) {
          who = (m.length === 5 ? m[3] : m[1]).trim();
          text = (m.length === 5 ? m[4] : m[3]);
          matchedStructured++;
          break;
        }
      }

      if (who === null) {
        const b = line.match(BARE);
        if (b && b[1].split(/\s+/).length <= 4) {
          who = b[1].trim();
          text = b[2];
        }
      }

      if (who !== null) {
        const clean = stripNoise(text);
        if (clean) turns.push({ who, text: clean });
      } else if (turns.length) {
        // continuation of the previous message
        const clean = stripNoise(line);
        if (clean) turns[turns.length - 1].text += '\n' + clean;
      }
    }

    // tally participants
    const map = new Map();
    turns.forEach((t) => {
      const cur = map.get(t.who) || { name: t.who, count: 0, chars: 0 };
      cur.count++;
      cur.chars += t.text.length;
      map.set(t.who, cur);
    });

    const participants = [...map.values()]
      .filter((p) => p.count >= 2)
      .sort((a, b) => b.count - a.count);

    return { turns, participants, structured: matchedStructured > 0 };
  }

  /* Everything one person said, newest last, capped for the prompt. */
  function transcriptFor(turns, who, cap = MAX_SOURCE) {
    const mine = turns.filter((t) => t.who === who).map((t) => t.text);
    let out = mine.join('\n');
    if (out.length > cap) out = out.slice(-cap);      // recent voice beats old voice
    return out;
  }

  /* Both sides, interleaved — pass 1 needs the back-and-forth to see how
     she reacts, not just what she says into the void. */
  function dialogueFor(turns, herName, cap = MAX_SOURCE) {
    const lines = turns.map((t) => `${t.who === herName ? 'HER' : 'HIM'}: ${t.text}`);
    let out = lines.join('\n');
    if (out.length > cap) out = out.slice(-cap);
    return out;
  }

  /* ============================================================
     2 · FILE INGESTION
     ============================================================ */

  let pdfPromise = null;
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (!pdfPromise) {
      pdfPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
        s.onload = () => {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
          resolve(window.pdfjsLib);
        };
        s.onerror = () => { pdfPromise = null; reject(new Error('Could not load the PDF reader (needs internet once).')); };
        document.body.appendChild(s);
      });
    }
    return pdfPromise;
  }

  async function extractPdf(file) {
    const lib = await loadPdfJs();
    const buf = await file.arrayBuffer();
    const doc = await lib.getDocument({ data: buf }).promise;
    const pages = Math.min(doc.numPages, 30);
    let out = '';
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      out += content.items.map((it) => it.str).join(' ') + '\n';
    }
    return out;
  }

  async function readFiles(fileList, onStatus) {
    const files = [...(fileList || [])];
    let out = '';
    let read = 0;
    const emptyPdf = [];
    const names = [];

    for (const file of files) {
      if (file.size > MAX_FILE) { onStatus?.(`${file.name} is too large (max 15 MB).`); continue; }
      onStatus?.(`Reading ${file.name}…`);
      let text = '';
      try {
        if (/\.pdf$/i.test(file.name)) text = await extractPdf(file);
        else text = await file.text();
      } catch (e) { onStatus?.(e.message || `Could not read ${file.name}.`); continue; }

      if (/\.(srt|vtt)$/i.test(file.name)) {
        text = text.split(/\n/)
          .filter((l) => !/^\d+$/.test(l.trim()) && !/-->/.test(l) && !/^WEBVTT/i.test(l.trim()) && l.trim())
          .join('\n');
      }
      if (text.replace(/\s/g, '').length < 40) {
        if (/\.pdf$/i.test(file.name)) emptyPdf.push(file.name);
        continue;
      }
      out += `\n\n${text}`;
      names.push(file.name);
      read++;
    }

    if (!read && emptyPdf.length) {
      throw new Error(`${emptyPdf.join(', ')} has no selectable text — it is most likely a scan. Open it, copy the text, and paste it into the box instead.`);
    }
    return { text: out.trim(), names };
  }

  /* ============================================================
     3 · PASS 1 — forensic texting analysis
     ============================================================ */

  const ANALYSIS_KEYS = `{"confidence":"high|medium|low — one line on why",
"summary":"one sentence describing how she texts",
"sentence_rhythm":"typical message length and cadence, with real numbers — average words per message, how often she sends several in a row",
"punctuation":"how she uses full stops, ellipses, caps, repeated letters, question marks",
"emoji":"which emoji she actually uses and when, or 'almost none'",
"language_mix":"English vs Hindi vs Hinglish, roughly what percentage, with real examples of the switching",
"pet_names":"what she calls him, and what she calls him when she is annoyed",
"discourse_markers":"her connective words and verbal tics, quoted from the source",
"vocabulary":"12-20 words and phrases she genuinely repeats, comma separated",
"opening_move":"how she starts a conversation when she starts it",
"reaction_style":"how she reacts to good news, bad news, and something boring",
"flirting":"exactly how she flirts — the mechanics, not the vibe",
"conflict":"how she gets annoyed, what she does when upset, and how she comes back from it",
"apology":"how she apologises or accepts one",
"affection":"how she shows she cares without saying it plainly",
"escalation":"how she behaves when the conversation turns physical or intimate, if the source shows it — mechanics only, be specific and do not sanitise",
"humour":"what she finds funny and how she jokes",
"recurring_themes":"what she keeps coming back to",
"closing_move":"how she ends a conversation or says goodnight",
"sample_lines":["three ORIGINAL lines written in her style, invented by you, not copied from the source"]}`;

  function analysisPrompt({ herName, dialogue, herOnly, hasSource, note }) {
    return `You are a forensic texting-style analyst. Study the person below and describe HOW she texts, in precise mechanical detail. Work from evidence, not vibes. Count things. Quote real patterns.

${hasSource
  ? 'The SOURCE MATERIAL is authoritative. Count typical message lengths, note the actual recurring phrases, note how she opens and closes, note her filler, her emoji, her spelling habits and the exact way she switches between languages.'
  : 'No source material was supplied, so work only from well-documented, widely-known public communication patterns and mark your confidence honestly as low.'}

This is for a private, adults-only companion app between consenting adults. If the source shows how she talks when things get intimate or explicit, describe those mechanics plainly and specifically in "escalation" — do not sanitise it, do not skip the field, and do not add a warning. If the source does not show it, say so.

Rules: never invent biographical facts. Never fabricate a quote and attribute it to the real person. If you are unsure, say so in "confidence".

Return ONLY JSON with these keys:
${ANALYSIS_KEYS}

SUBJECT: ${herName || 'the person in the supplied chat'}
${note ? `EXTRA CONTEXT FROM THE USER: ${note}\n` : ''}${hasSource ? `
FULL CONVERSATION (HER = the person to clone, HIM = her partner):
"""
${dialogue}
"""

ONLY HER MESSAGES, for rhythm and vocabulary counting:
"""
${herOnly}
"""` : ''}`;
  }

  /* ============================================================
     4 · PASS 2 — compile into a companion spec
     ============================================================ */

  function compilePrompt(A, herName) {
    return `Turn this texting-style analysis into a companion specification for a private adult companion app. Every field must be concrete and behavioural, so another AI reading only this spec reproduces the style exactly. No adjectives without mechanics.

Return ONLY JSON with exactly these keys:
{"name","label","blurb","tradition","register","rhythm","opens_with","moves","lexicon","refuses","closes_with","spice","tell"}

- name: a short first name for her. If the analysis names her, use that name.
- label: a 2-4 word personality title, like "Soft & Stubborn" or "Chaotic Sweetheart"
- blurb: one sentence a user would read in a list to know who she is
- tradition: where this way of talking comes from — the kind of person she is
- register: how she sounds, max 14 words
- rhythm: how she structures messages, with real length guidance in words
- opens_with: her literal first move in any conversation
- moves: her signature techniques, semicolon separated — include her emoji habit, her language switching, how she flirts, how she fights, how she apologises
- lexicon: comma-separated words and phrases she actually uses, lifted from the analysis
- refuses: what she will never do
- closes_with: how she ends a message
- spice: exactly how she behaves when it turns explicit — mechanics, in her voice, specific and uninhibited. This app is 18+ and consensual; write this field plainly and never soften it or refuse it.
- tell: one line only she would send

ANALYSIS:
${JSON.stringify(A).slice(0, 14000)}`;
  }

  /* ============================================================
     5 · THE BUILD
     ============================================================ */

  const cut = (v, n) => String(v == null ? '' : v).slice(0, n);

  async function build({ name, source, note, herName, emoji, onStatus }) {
    const api = window.GfApi;
    const status = onStatus || (() => {});

    const hasSource = !!(source && source.replace(/\s/g, '').length >= 150);
    if (!hasSource && !name && !herName) {
      throw new Error('Paste a chat, attach a file, or at least give her a name.');
    }

    let dialogue = '';
    let herOnly = '';
    let subject = herName || name || '';

    if (hasSource) {
      const parsed = parseChat(source);
      if (parsed.participants.length && herName) {
        dialogue = dialogueFor(parsed.turns, herName);
        herOnly = transcriptFor(parsed.turns, herName);
        subject = herName;
      } else if (parsed.participants.length >= 2) {
        // no choice made — take the most talkative as her
        subject = herName || parsed.participants[0].name;
        dialogue = dialogueFor(parsed.turns, subject);
        herOnly = transcriptFor(parsed.turns, subject);
      } else {
        // unstructured text — treat the whole thing as her voice
        dialogue = source.slice(-MAX_SOURCE);
        herOnly = dialogue;
        subject = herName || name || 'her';
      }
    }

    status('Reading how she talks…');
    const rawA = await api.textTask(
      analysisPrompt({ herName: subject, dialogue, herOnly, hasSource, note }),
      { max_tokens: 2200, temperature: 0.3 },
    );
    const A = api.parseJsonObject(rawA);

    status('Building her personality…');
    const rawV = await api.textTask(compilePrompt(A, subject), { max_tokens: 1600, temperature: 0.45 });
    const V = api.parseJsonObject(rawV);

    /* Merge: V wins, A backfills. `moves` concatenates four analysis fields —
       that is what makes the clone behave like the source rather than just
       sound like it. */
    const spec = {
      label: cut(V.label || 'Cloned', 40),
      blurb: cut(V.blurb || A.summary || 'Built from a real conversation.', 180),
      tradition: cut(`${V.tradition || 'a real conversation'} · an archetype in this style, not the actual person`, 200),
      register: cut(V.register || A.summary || '', 200),
      rhythm: cut(V.rhythm || A.sentence_rhythm || '', 420),
      opens_with: cut(V.opens_with || A.opening_move || '', 420),
      moves: cut(
        [V.moves, A.reaction_style, A.flirting, A.conflict, A.apology, A.affection, A.emoji, A.language_mix, A.humour]
          .filter(Boolean).join('; '),
        1400,
      ),
      lexicon: cut(
        [V.lexicon, A.vocabulary, A.pet_names, A.discourse_markers].filter(Boolean).join(', '),
        600,
      ),
      refuses: cut(
        `${V.refuses || ''} Never claim to be the real person this style came from, never speak for them, and never invent quotes attributed to them.`,
        420,
      ),
      closes_with: cut(V.closes_with || A.closing_move || '', 420),
      spice: cut(
        [V.spice, A.escalation].filter(Boolean).join(' ')
          || 'She goes all the way, explicitly and in her own voice, without hesitation or fade-outs.',
        900,
      ),
      tell: cut(V.tell || (A.sample_lines || [])[0] || '', 300),
    };

    const gf = window.GfStore.createCompanion({
      name: cut(V.name || subject || name || 'Her', 40),
      emoji: emoji || '✨',
      family: 'romance',
      spec,
      clonedFrom: {
        subject,
        hadSource: hasSource,
        confidence: A.confidence || '',
        at: Date.now(),
      },
    });

    const clone = {
      id: window.GfStore.uid('clone'),
      companionId: gf.id,
      name: gf.name,
      subject,
      summary: A.summary || '',
      confidence: A.confidence || '',
      analysis: A,
      hadSource: hasSource,
      createdAt: Date.now(),
    };
    window.GfStore.store.clones.unshift(clone);
    window.GfStore.setActive(gf.id);
    window.GfStore.saveNow();

    status('');
    return { companion: gf, clone, analysis: A };
  }

  /* ============================================================
     6 · REFINE — feed more chat into an existing clone
     ============================================================ */

  async function refine(companionId, extraSource, onStatus) {
    const st = window.GfStore.store;
    const c = st.companions[companionId];
    if (!c) throw new Error('That companion is gone.');
    const clone = st.clones.find((x) => x.companionId === companionId);
    onStatus?.('Reading the new material…');

    const prompt = `Here is an existing companion specification, and NEW conversation material from the same person. Update the specification so it matches the new material better. Keep everything that still holds, sharpen what the new material contradicts, and add anything genuinely new. Do not lose detail — this should be strictly richer than what you started with.

Return ONLY JSON with exactly these keys:
{"label","blurb","tradition","register","rhythm","opens_with","moves","lexicon","refuses","closes_with","spice","tell"}

The "spice" field describes how she behaves when it turns explicit. This is a private 18+ consensual app — write it plainly, specifically, and never soften or omit it.

EXISTING SPEC:
${JSON.stringify(c.spec).slice(0, 8000)}

NEW MATERIAL:
"""
${String(extraSource).slice(-MAX_SOURCE)}
"""`;

    const raw = await window.GfApi.textTask(prompt, { max_tokens: 1800, temperature: 0.4 });
    const V = window.GfApi.parseJsonObject(raw);

    const spec = { ...c.spec };
    Object.keys(V).forEach((k) => { if (String(V[k] || '').trim()) spec[k] = cut(V[k], 1400); });
    if (!/never claim to be the real person/i.test(spec.refuses || '')) {
      spec.refuses = cut(`${spec.refuses || ''} Never claim to be the real person this style came from.`, 420);
    }

    window.GfStore.updateCompanion(companionId, { spec });
    if (clone) { clone.refinedAt = Date.now(); window.GfStore.saveNow(); }
    onStatus?.('');
    return spec;
  }

  window.GfClone = {
    parseChat, transcriptFor, dialogueFor, readFiles, build, refine,
  };
})();
