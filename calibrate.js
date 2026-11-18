/* Calibration — rewrites taste.json from reactions to real past picks.

   Two months of digests matched the guessed profile 7% of the time, so this
   asks about actual pieces instead. Same origin as the gallery, which matters:
   the hearts already sitting in localStorage are read straight out of it. */
(() => {
  'use strict';

  const SAMPLE_URL = 'data/calibration.json';
  const LIKES_KEY = 'artDigest.likes'; // written by the gallery, same origin
  const PREFS_KEY = 'artDigest.calibration';
  const REPO = 'JasonLayel/art-digest';

  const $ = (id) => document.getElementById(id);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const isSafeUrl = (url) => typeof url === 'string' && /^https:\/\//i.test(url);

  const state = {
    queue: [],
    at: 0,
    verdicts: new Map(), // id -> 'keep' | 'skip'
    items: new Map(), // id -> item
    imported: 0,
    blur: true,
  };

  /* ------------------------------------------------------------- vocabulary */

  // Words that describe nothing on their own. Kept deliberately small: the
  // point is to learn your vocabulary, not to impose mine.
  const STOPWORDS = new Set(
    ('a an and the of in on at to for with by from is it this that my our your their ' +
      'new first last day today more most very just some any all one two three oc art ' +
      'artwork drawing painting illustration digital original commission done made finished ' +
      'wip sketch study practice fan fanart版 ver version part page final update')
      .split(/\s+/)
      .filter(Boolean)
  );

  /**
   * Danbooru tags an unknown artist "anon", and the gallery shows it like a
   * name. Learned as one it matched four unrelated people on the first run.
   */
  const PLACEHOLDER_ARTISTS = new Set(['anon', 'anonymous', 'unknown', 'various', 'n/a', 'none', 'artist request', 'deleted']);
  const isPlaceholderArtist = (name) => PLACEHOLDER_ARTISTS.has(String(name || '').trim().toLowerCase().replace(/^u\//, ''));

  /** A context that names a rank rather than a subject. */
  const isPositional = (context) => /#\s*\d+|\branking\b|\bno\.?\s*\d+/i.test(String(context || ''));

  function wordsOf(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, ' ')
      .split(/[^a-z0-9']+/)
      .map((w) => w.replace(/^'+|'+$/g, ''))
      .filter((w) => w.length >= 3 && w.length <= 24 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  }

  /* ------------------------------------------------------------------ data */

  /** Hearts the gallery already stored on this device. */
  function importedLikes() {
    try {
      const saved = JSON.parse(localStorage.getItem(LIKES_KEY) || '[]');
      return Array.isArray(saved) ? saved.filter((l) => l && l.id) : [];
    } catch {
      return []; // blocked storage just means nothing to import
    }
  }

  function loadPrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      if (typeof saved.blur === 'boolean') state.blur = saved.blur;
      if (saved.verdicts && typeof saved.verdicts === 'object') {
        for (const [id, verdict] of Object.entries(saved.verdicts)) {
          if (verdict === 'keep' || verdict === 'skip') state.verdicts.set(id, verdict);
        }
      }
    } catch {
      /* nothing saved yet */
    }
  }

  function savePrefs() {
    try {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ blur: state.blur, verdicts: Object.fromEntries(state.verdicts) })
      );
    } catch {
      /* the run simply will not survive a reload */
    }
  }

  /* --------------------------------------------------------------- rating */

  function renderCard() {
    const stage = $('stage');
    stage.textContent = '';
    const item = state.queue[state.at];

    if (!item) {
      $('verdict').classList.add('hidden');
      $('helpers').classList.add('hidden');
      // The stage reserves 60vh for a card; with no card that is a screen of
      // nothing between the header and the result.
      stage.classList.add('done');
      renderResult();
      $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    stage.classList.remove('done');
    $('verdict').classList.remove('hidden');
    $('helpers').classList.remove('hidden');

    const card = el('article', 'rate-card');
    const shade = el('div', 'rate-shot');
    if (isSafeUrl(item.thumb)) {
      const img = el('img');
      img.referrerPolicy = 'no-referrer'; // before src, or it is never sent
      img.alt = '';
      img.loading = 'eager';
      img.decoding = 'async';
      img.src = item.thumb;
      if (item.nsfw && state.blur) img.classList.add('blurred');
      img.addEventListener('error', () => {
        img.remove();
        shade.classList.add('no-image');
        shade.append(el('p', 'gone', 'This image no longer loads — judge it by the title.'));
      });
      shade.append(img);
    } else {
      shade.classList.add('no-image');
      shade.append(el('p', 'gone', 'No thumbnail was saved for this one.'));
    }
    card.append(shade);

    const meta = el('div', 'rate-meta');
    const where = [item.source, item.context].filter(Boolean).join(' · ');
    const tag = el('p', 'rate-where', where);
    if (item.nsfw) tag.append(el('span', 'badge-18', ' 18+'));
    meta.append(tag);
    const title = el('h2', 'rate-title');
    if (isSafeUrl(item.url)) {
      const link = el('a', null, item.title);
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      title.append(link);
    } else {
      title.textContent = item.title;
    }
    meta.append(title);
    if (item.artist) meta.append(el('p', 'rate-artist', item.artist));
    card.append(meta);
    stage.append(card);

    const done = state.verdicts.size;
    $('progress').textContent = `${state.at + 1} of ${state.queue.length} · ${done} rated`;
  }

  function judge(verdict) {
    const item = state.queue[state.at];
    if (!item) return;
    state.verdicts.set(item.id, verdict);
    state.at++;
    savePrefs();
    renderCard();
  }

  function undo() {
    if (state.at === 0) return;
    state.at--;
    const item = state.queue[state.at];
    if (item) state.verdicts.delete(item.id);
    savePrefs();
    renderCard();
  }

  /* ------------------------------------------------------------- the profile */

  const round = (n) => Math.round(n * 100) / 100;

  /**
   * Turns verdicts into a profile.
   *
   * Context is weighted hardest because the archive says it is the only strong
   * signal: r/conceptart and r/ImaginaryArchitecture landed every time, while
   * keyword-on-title matched 53 picks in two months — ArtStation titles are
   * "Marsh Fortress", not "architecture".
   *
   * Skips matter as much as keeps. The old profile had an empty mute list and
   * no way to say no, which is why half the digest was work nobody wanted.
   */
  function buildProfile(verdicts, items) {
    const keywords = {};
    const artists = {};
    const contexts = {};
    const sources = {};
    const mute = [];

    const tally = new Map(); // context -> {keep, skip}
    const perSource = new Map(); // source -> {keep, skip}
    const bump = (table, key, by) => {
      const name = String(key || '').trim();
      if (!name) return;
      table[name] = round(Math.min(10, (table[name] || 0) + by));
    };

    const kept = [];
    const skipped = [];
    for (const [id, verdict] of verdicts) {
      const item = items.get(id);
      if (!item) continue;
      (verdict === 'keep' ? kept : skipped).push(item);
      const key = item.context || `${item.source} (no context)`;
      if (!tally.has(key)) tally.set(key, { keep: 0, skip: 0, source: item.source, context: item.context });
      tally.get(key)[verdict === 'keep' ? 'keep' : 'skip']++;
      if (item.source) {
        if (!perSource.has(item.source)) perSource.set(item.source, { keep: 0, skip: 0 });
        perSource.get(item.source)[verdict === 'keep' ? 'keep' : 'skip']++;
      }
    }

    for (const item of kept) {
      if (item.artist && !isPlaceholderArtist(item.artist)) {
        bump(artists, String(item.artist).replace(/^u\//, ''), 1);
      }
      for (const word of wordsOf(item.title)) bump(keywords, word, 0.5);
    }

    // A word you kept twice and never skipped is a subject. A word that shows
    // up on both sides is noise, so it loses the weight it gained.
    const skipWords = new Map();
    for (const item of skipped) for (const word of wordsOf(item.title)) skipWords.set(word, (skipWords.get(word) || 0) + 1);
    for (const word of Object.keys(keywords)) {
      const against = skipWords.get(word) || 0;
      if (against) keywords[word] = round(Math.max(0, keywords[word] - against * 0.5));
      if (keywords[word] <= 0) delete keywords[word];
    }

    // How many of a source's rated pieces each context accounted for. A context
    // that covers nearly all of them is not a subject — ArtStation files every
    // one of its picks under "Trending" — and weighting it would boost the
    // whole source a second time, on top of its share below.
    const sourceTotals = new Map();
    for (const counts of tally.values()) {
      const seen = counts.keep + counts.skip;
      sourceTotals.set(counts.source, (sourceTotals.get(counts.source) || 0) + seen);
    }

    for (const [key, counts] of tally) {
      const seen = counts.keep + counts.skip;
      const coversItsSource = seen / (sourceTotals.get(counts.source) || seen) >= 0.8;
      if (coversItsSource) continue;
      // Pixiv labels every pick with where it placed — "Daily ranking #36" —
      // which is a position, not a subject. Learning it would teach the digest
      // to favour whatever lands at 36 tomorrow. Pixiv's signal is its share.
      if (isPositional(counts.context)) continue;
      if (counts.keep && counts.keep >= counts.skip) {
        // Weighted by how many times you kept it, not just how reliably: the
        // sample shows most contexts once, so a rate alone scores everything
        // identically and tells the digest nothing it did not already know.
        bump(contexts, counts.context || key, 1 + counts.keep * (counts.keep / seen));
      }
      // Muting rejects a piece outright, so it needs more than one bad day:
      // asked about at least twice, and never once kept.
      if (counts.keep === 0 && seen >= 2 && counts.context) mute.push(counts.context);
    }

    // The share of the digest each source gets, which is the lever the archive
    // actually pointed at: for two months Pixiv and Danbooru held 47% of every
    // digest between them and matched the profile once in 1,464 picks. A source
    // is only dropped on real evidence — asked about at least four times and
    // kept none — because dropping one is how a whole medium disappears.
    for (const [source, counts] of perSource) {
      const seen = counts.keep + counts.skip;
      const rate = counts.keep / seen;
      if (seen >= 4 && counts.keep === 0) sources[source] = 0;
      else if (seen >= 4 && rate >= 0.6) sources[source] = 2;
      else if (seen >= 4 && rate <= 0.25) sources[source] = 1; // kept, but on a short leash
    }

    // A fandom name already carries as a context ("blue archive"), so its
    // fragments in a title are noise that matches far too much: "blue",
    // "archive", "impact", "white". Drop any word contained in a context we
    // are already weighting.
    const covered = new Set();
    for (const name of Object.keys(contexts)) for (const word of wordsOf(name)) covered.add(word);
    for (const word of Object.keys(keywords)) if (covered.has(word)) delete keywords[word];

    const trim = (table, max, floor = 0) =>
      Object.fromEntries(
        Object.entries(table)
          .filter(([, weight]) => weight > floor)
          .sort((a, b) => b[1] - a[1])
          .slice(0, max)
      );

    return {
      // A word has to turn up in three kept titles to count. Two let through
      // "souvenir" and "white", which match nothing anyone meant.
      keywords: trim(keywords, 120, 1),
      artists: trim(artists, 60),
      contexts: trim(contexts, 60),
      sources,
      mute: mute.slice(0, 40),
    };
  }

  /* -------------------------------------------------------------- the result */

  function issueUrl(profile, counts) {
    const body = [
      `Calibrated against ${counts.rated} pieces from the archive` +
        (state.imported ? `, plus ${state.imported} heart${state.imported === 1 ? '' : 's'} already saved in the gallery` : '') +
        `.`,
      '',
      `Kept ${counts.kept}, skipped ${counts.skipped}.`,
      '',
      'Replace the profile with this:',
      '',
      '```json',
      JSON.stringify({ profile }, null, 2),
      '```',
    ].join('\n');
    return (
      `https://github.com/${REPO}/issues/new?title=${encodeURIComponent('Calibrate the digest')}` +
      `&body=${encodeURIComponent(body)}`
    );
  }

  function renderResult() {
    const panel = $('result');
    panel.classList.remove('hidden');
    panel.textContent = '';
    $('progress').textContent = state.verdicts.size ? `${state.verdicts.size} rated` : 'Nothing rated yet';

    const kept = [...state.verdicts.values()].filter((v) => v === 'keep').length;
    const skipped = state.verdicts.size - kept;
    const profile = buildProfile(state.verdicts, state.items);
    const counts = { rated: state.verdicts.size, kept, skipped };

    panel.append(el('h2', null, 'What that says'));
    if (!state.verdicts.size) {
      panel.append(el('p', 'fine', 'Nothing rated yet, so there is nothing to send.'));
      return;
    }
    panel.append(
      el('p', 'fine', `You kept ${kept} and skipped ${skipped}${state.imported ? `, on top of ${state.imported} already hearted in the gallery` : ''}.`)
    );

    const show = (label, entries, note) => {
      if (!entries.length) return;
      const box = el('div', 'result-group');
      box.append(el('h3', null, label));
      if (note) box.append(el('p', 'fine', note));
      const list = el('div', 'chips');
      for (const [name, weight] of entries.slice(0, 18)) {
        list.append(el('span', 'chip static', weight ? `${name} ${weight}` : name));
      }
      box.append(list);
      panel.append(box);
    };

    const SHARE = { 0: 'dropped entirely', 1: 'reduced share', 2: 'double share' };
    const shares = Object.entries(profile.sources);
    if (shares.length) {
      show(
        'How much of the digest each site gets',
        shares.map(([name, weight]) => [`${name}: ${SHARE[weight] || 'normal'}`, 0]),
        'This is the big one. Each site currently gets a sixth of every digest whether or not it carries what you like.'
      );
    }
    show('Lean toward', Object.entries(profile.contexts), 'Where your keeps came from — the strongest signal there is.');
    show('Subjects', Object.entries(profile.keywords), 'Words from the titles you kept, minus any that also showed up on skips.');
    show('Artists', Object.entries(profile.artists));
    if (profile.mute.length) {
      show(
        'Stop showing',
        profile.mute.map((m) => [m, 0]),
        'Asked about at least twice, kept zero times. These get rejected outright — look before you send.'
      );
    }

    // Two ways out, because the GitHub route needs a login and a phone browser
    // signed out of GitHub turns that into a dead end with the profile stuck
    // behind it.
    const payload = JSON.stringify({ profile }, null, 2);

    const copy = el('button', 'send-btn', '📋 Copy the profile');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(payload);
        copy.textContent = '✓ Copied — paste it to Claude';
      } catch {
        // Clipboard access is refused in plenty of mobile contexts; the text
        // is on the page below either way, so this is never a dead end.
        copy.textContent = 'Select the text below and copy it';
      }
    });
    panel.append(copy);
    panel.append(
      el('p', 'fine', 'No sign-in needed. Paste it into the chat and it gets applied for you — this is the easy one on a phone.')
    );

    // Shown open, not folded away. Sixty ratings got stranded on a phone once
    // because the only way to see them was behind a toggle and a login.
    const box = el('div', 'payload');
    box.append(el('p', 'fine', 'Or select this and copy it by hand:'));
    box.append(el('pre', null, payload));
    panel.append(box);

    // Phones have a native share sheet, which is the easy way to get text from
    // the device you rated on to the one you are typing on.
    if (navigator.share) {
      const share = el('button', 'send-btn ghost', '↗ Send it somewhere');
      share.type = 'button';
      share.addEventListener('click', () => {
        navigator.share({ title: 'Art digest profile', text: payload }).catch(() => {
          /* dismissed, which is not an error */
        });
      });
      panel.append(share);
    }

    const send = el('a', 'send-btn ghost', 'Or open a GitHub issue →');
    send.href = issueUrl(profile, counts);
    send.target = '_blank';
    send.rel = 'noopener noreferrer';
    panel.append(send);
    panel.append(
      el('p', 'fine', 'Applies itself within a minute, but needs you signed in to GitHub in this browser.')
    );

    const again = el('button', 'chip', '↻ Rate the rest');
    again.type = 'button';
    again.addEventListener('click', () => {
      const firstUnrated = state.queue.findIndex((i) => !state.verdicts.has(i.id));
      state.at = firstUnrated === -1 ? 0 : firstUnrated;
      panel.classList.add('hidden');
      renderCard();
    });
    panel.append(again);
  }

  /* ----------------------------------------------------------------- start */

  async function start() {
    loadPrefs();
    let sample = [];
    try {
      const res = await fetch(`${SAMPLE_URL}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      sample = Array.isArray(payload?.items) ? payload.items : [];
    } catch (err) {
      $('stage').textContent = '';
      $('stage').append(el('p', 'gone', `Couldn't load the sample (${err.message}).`));
      $('progress').textContent = 'Unavailable';
      return;
    }

    for (const item of sample) if (item?.id) state.items.set(item.id, item);

    // Hearts from the gallery are verdicts already given: count them, and do
    // not ask about them again.
    const hearts = importedLikes();
    for (const like of hearts) {
      if (!state.items.has(like.id)) {
        state.items.set(like.id, {
          id: like.id,
          source: like.source || '',
          context: like.context || '',
          title: like.title || '',
          artist: like.artist || '',
          thumb: '',
          url: '',
          nsfw: false,
        });
      }
      state.verdicts.set(like.id, 'keep');
    }
    state.imported = hearts.length;
    if (state.imported) {
      $('imported').classList.remove('hidden');
      $('imported').textContent =
        `Picked up ${state.imported} piece${state.imported === 1 ? '' : 's'} you already hearted in the gallery — ` +
        `counted as keeps, so you only have to rate the rest.`;
    }

    state.queue = sample.filter((item) => !state.verdicts.has(item.id));
    const firstUnrated = state.queue.findIndex((i) => !state.verdicts.has(i.id));
    state.at = firstUnrated === -1 ? state.queue.length : firstUnrated;
    renderCard();
  }

  $('keep').addEventListener('click', () => judge('keep'));
  $('skip').addEventListener('click', () => judge('skip'));
  $('undo').addEventListener('click', undo);
  $('finish').addEventListener('click', () => {
    state.at = state.queue.length;
    renderCard();
  });
  $('blur').addEventListener('click', () => {
    state.blur = !state.blur;
    $('blur').textContent = state.blur ? '👁 Blur 18+' : '🚫 Unblurred';
    savePrefs();
    renderCard();
  });
  document.addEventListener('keydown', (event) => {
    if (event.target.matches('input, textarea')) return;
    if (event.key === 'ArrowRight') judge('keep');
    else if (event.key === 'ArrowLeft') judge('skip');
    else if (event.key === 'Backspace') {
      event.preventDefault();
      undo();
    }
  });

  start();
})();
