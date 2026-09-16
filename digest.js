/* Daily Digital Art Digest — renders data/latest.json, written by collect.mjs.
   No build step, no dependencies: drop the folder on any static host. */
(() => {
  'use strict';

  const FEED_URL = 'data/latest.json';
  const PREFS_KEY = 'artDigest.prefs';
  // Used only by the live top-up below; the real collection happens in CI.
  const LIVE_SUBS = 'Art+DigitalArt+ImaginaryLandscapes+ImaginaryCharacters+ConceptArt';
  const STALE_AFTER_HOURS = 36;

  const SOURCE_META = {
    artstation: { label: 'ArtStation', color: 'var(--artstation)' },
    reddit: { label: 'Reddit', color: 'var(--reddit)' },
    pixiv: { label: 'Pixiv', color: 'var(--pixiv)' },
    deviantart: { label: 'DeviantArt', color: 'var(--deviantart)' },
    bluesky: { label: 'Bluesky', color: 'var(--bluesky)' },
    danbooru: { label: 'Danbooru', color: 'var(--danbooru)' },
  };

  const $ = (id) => document.getElementById(id);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  const state = {
    digest: null,
    source: 'all',
    sort: 'heat',
    rating: 'all', // all | sfw | nsfw
    blur: false,
  };

  /* ------------------------------------------------------------- helpers */

  function loadPrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      if (saved.source) state.source = saved.source;
      if (saved.sort === 'new' || saved.sort === 'heat') state.sort = saved.sort;
      if (['all', 'sfw', 'nsfw'].includes(saved.rating)) state.rating = saved.rating;
      state.blur = Boolean(saved.blur);
    } catch {
      /* private mode or blocked storage: defaults are fine */
    }
  }

  function savePrefs() {
    try {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ source: state.source, sort: state.sort, rating: state.rating, blur: state.blur })
      );
    } catch {
      /* nothing to do — prefs are a convenience */
    }
  }

  function timeAgo(isoString) {
    const then = Date.parse(isoString);
    if (!Number.isFinite(then)) return '';
    const mins = Math.round((Date.now() - then) / 60000);
    if (mins < 2) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return days === 1 ? 'yesterday' : `${days} days ago`;
  }

  const isSafeUrl = (url) => typeof url === 'string' && /^https:\/\//i.test(url);

  /* ------------------------------------------------------------ rendering */

  function render() {
    renderFilters();
    renderRatingFilter();
    renderGrid();
    renderSources();
  }

  function visibleItems() {
    const items = (state.digest?.items || []).filter(
      (item) =>
        (state.source === 'all' || item.source === state.source) &&
        (state.rating === 'all' ||
          (state.rating === 'sfw' && !item.nsfw) ||
          (state.rating === 'nsfw' && item.nsfw))
    );
    if (state.sort === 'new') {
      return [...items].sort((a, b) => (Date.parse(b.postedAt) || 0) - (Date.parse(a.postedAt) || 0));
    }
    return [...items].sort((a, b) => (b.heat || 0) - (a.heat || 0));
  }

  function renderFilters() {
    const box = $('filters');
    box.textContent = '';
    const items = state.digest?.items || [];
    const counts = items.reduce((acc, item) => {
      acc[item.source] = (acc[item.source] || 0) + 1;
      return acc;
    }, {});

    const make = (id, label, count, color) => {
      const chip = el('button', 'chip');
      chip.type = 'button';
      chip.dataset.source = id;
      chip.append(label);
      if (count != null) chip.append(el('span', 'count', String(count)));
      if (color) chip.style.setProperty('--chip-color', color);
      if (state.source === id) chip.classList.add('is-on');
      chip.setAttribute('aria-pressed', String(state.source === id));
      chip.addEventListener('click', () => {
        state.source = id;
        savePrefs();
        render();
      });
      return chip;
    };

    box.append(make('all', 'All', items.length, null));
    Object.entries(SOURCE_META).forEach(([id, meta]) => {
      if (counts[id]) box.append(make(id, meta.label, counts[id], meta.color));
    });
  }

  function renderRatingFilter() {
    const box = $('ratings');
    box.textContent = '';
    const items = state.digest?.items || [];
    const adult = items.filter((item) => item.nsfw).length;
    if (!adult) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');

    const chip = (rating, label, count) => {
      const button = el('button', 'chip');
      button.type = 'button';
      button.append(label);
      if (count != null) button.append(el('span', 'count', String(count)));
      button.classList.toggle('is-on', state.rating === rating);
      button.setAttribute('aria-pressed', String(state.rating === rating));
      if (rating === 'nsfw') button.style.setProperty('--chip-color', 'var(--nsfw)');
      button.addEventListener('click', () => {
        state.rating = rating;
        savePrefs();
        render();
      });
      return button;
    };

    box.append(chip('all', 'Everything', items.length));
    box.append(chip('sfw', 'SFW', items.length - adult));
    box.append(chip('nsfw', '18+', adult));

    const blur = el('button', 'chip');
    blur.type = 'button';
    blur.append(state.blur ? '👁 Blurred' : '👁 Unblurred');
    blur.title = 'Blur 18+ thumbnails until you click them';
    blur.classList.toggle('is-on', state.blur);
    blur.setAttribute('aria-pressed', String(state.blur));
    blur.addEventListener('click', () => {
      state.blur = !state.blur;
      savePrefs();
      render();
    });
    box.append(blur);
  }

  function renderCard(item, index) {
    const meta = SOURCE_META[item.source] || { label: item.source, color: 'var(--accent)' };
    const card = el('article', 'card');
    card.style.setProperty('--source-color', meta.color);

    const link = el('a', 'thumb-link');
    link.href = isSafeUrl(item.url) ? item.url : '#';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `${item.title} by ${item.artist || 'unknown artist'} on ${meta.label}`);

    const thumbUrl = item.thumb || item.image;
    if (isSafeUrl(thumbUrl)) {
      const img = el('img');
      img.src = thumbUrl;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      // Derived thumbnails (ArtStation's upsized covers, Pixiv's mirror) can
      // stop resolving, so walk the source's fallbacks before giving up.
      const fallbacks = (item.thumbFallbacks || []).filter((url) => isSafeUrl(url) && url !== thumbUrl);
      img.addEventListener('error', () => {
        const next = fallbacks.shift();
        if (next) {
          img.src = next;
          return;
        }
        img.remove();
        link.prepend(el('div', 'thumb-fallback', item.title));
      });
      link.append(img);
    } else {
      link.append(el('div', 'thumb-fallback', item.title));
    }

    link.append(el('span', 'rank', `#${index + 1}`));
    if (Number.isFinite(item.heat)) link.append(el('span', 'heat', `🔥 ${item.heat}`));

    if (item.nsfw) {
      card.classList.add('is-nsfw');
      link.append(el('span', 'nsfw-tag', '18+'));
      if (state.blur) {
        card.classList.add('is-blurred');
        const reveal = el('button', 'reveal', '18+ · click to show');
        reveal.type = 'button';
        reveal.addEventListener('click', (event) => {
          event.preventDefault();
          card.classList.remove('is-blurred');
          reveal.remove();
        });
        link.append(reveal);
      }
    }
    card.append(link);

    const body = el('div', 'card-body');
    const badge = el('span', 'badge', item.context ? `${meta.label} · ${item.context}` : meta.label);
    if (item.nsfw) badge.append(el('span', 'badge-nsfw', '18+'));
    body.append(badge);

    const title = el('h2', 'card-title');
    const titleLink = el('a', null, item.title || 'Untitled');
    titleLink.href = link.href;
    titleLink.target = '_blank';
    titleLink.rel = 'noopener noreferrer';
    title.append(titleLink);
    body.append(title);

    if (item.artist) {
      const artist = el('p', 'artist');
      if (isSafeUrl(item.artistUrl)) {
        const a = el('a', null, item.artist);
        a.href = item.artistUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        artist.append(a);
      } else {
        artist.append(item.artist);
      }
      body.append(artist);
    }

    const stats = el('div', 'stats');
    stats.append(el('span', null, item.scoreLabel || ''));
    stats.append(el('span', null, timeAgo(item.postedAt)));
    body.append(stats);

    card.append(body);
    return card;
  }

  function renderGrid() {
    const grid = $('grid');
    const items = visibleItems();
    grid.textContent = '';
    grid.setAttribute('aria-busy', 'false');
    items.forEach((item, i) => grid.append(renderCard(item, i)));
    $('empty').classList.toggle('hidden', items.length > 0);
  }

  function renderSources() {
    const box = $('sources');
    box.textContent = '';
    (state.digest?.sources || []).forEach((source) => {
      const span = el('span', source.status === 'ok' ? 'ok' : 'bad');
      span.textContent =
        source.status === 'ok'
          ? `${source.label} — ${source.kept} pieces`
          : `${source.label} — unavailable`;
      if (source.error) span.title = source.error;
      box.append(span);
    });
  }

  function setNotice(message) {
    const notice = $('notice');
    notice.textContent = message || '';
    notice.classList.toggle('hidden', !message);
  }

  function setUpdated(text) {
    $('updated').textContent = text;
  }

  /* --------------------------------------------------------------- data */

  async function fetchDigest() {
    // A single-file copy of the page carries its digest inline, so there is
    // nothing to fetch and it works anywhere — including offline.
    if (window.__ART_DIGEST__ && Array.isArray(window.__ART_DIGEST__.items)) {
      return window.__ART_DIGEST__;
    }
    const res = await fetch(`${FEED_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const digest = await res.json();
    if (!Array.isArray(digest.items)) throw new Error('malformed digest');
    return digest;
  }

  /**
   * Fallback when the collected feed is missing or stale: Reddit is the one
   * source that allows cross-origin reads straight from the browser, so the
   * widget can still show something current on its own.
   */
  async function fetchLiveReddit() {
    const url = `https://www.reddit.com/r/${LIVE_SUBS}/top.json?t=day&limit=40&raw_json=1`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    const posts = (payload?.data?.children || [])
      .map((child) => child.data)
      .filter((p) => p && !p.over_18 && !p.is_self && !p.stickied);

    const top = Math.max(1, ...posts.map((p) => p.score || 0));
    const items = posts
      .map((p) => {
        const preview = p.preview?.images?.[0];
        const image = preview?.source?.url || p.url_overridden_by_dest || '';
        return {
          id: `reddit:${p.id}`,
          source: 'reddit',
          title: p.title || 'Untitled',
          artist: p.author ? `u/${p.author}` : '',
          artistUrl: p.author ? `https://www.reddit.com/user/${p.author}` : '',
          url: `https://www.reddit.com${p.permalink}`,
          image,
          thumb: preview?.resolutions?.slice(-2)[0]?.url || image,
          heat: Math.round(((p.score || 0) / top) * 100),
          scoreLabel: `${p.score >= 1000 ? `${(p.score / 1000).toFixed(1)}k` : p.score} upvotes`,
          postedAt: new Date((p.created_utc || 0) * 1000).toISOString(),
          context: p.subreddit_name_prefixed || '',
        };
      })
      .filter((item) => /^https:\/\//.test(item.thumb))
      .sort((a, b) => b.heat - a.heat)
      .slice(0, 24);

    return {
      generatedAt: new Date().toISOString(),
      items,
      sources: [{ id: 'reddit', label: 'Reddit (live)', status: 'ok', kept: items.length }],
      live: true,
    };
  }

  async function load() {
    const button = $('refresh');
    button.classList.add('spin');
    setNotice('');
    try {
      const digest = await fetchDigest();
      state.digest = digest;
      const age = (Date.now() - Date.parse(digest.generatedAt)) / 3.6e6;
      setUpdated(`Updated ${timeAgo(digest.generatedAt)}`);
      render();
      if (age > STALE_AFTER_HOURS) await topUpLive('The collected digest is a while old, so this also pulled fresh Reddit picks.');
    } catch (err) {
      setUpdated('No digest yet');
      state.digest = { items: [], sources: [] };
      render();
      await topUpLive(`Couldn't load the collected digest (${err.message}), so this is a live pull from Reddit only.`);
    } finally {
      button.classList.remove('spin');
    }
  }

  async function topUpLive(message) {
    try {
      const live = await fetchLiveReddit();
      const known = new Set((state.digest?.items || []).map((item) => item.id));
      const merged = [...(state.digest?.items || []), ...live.items.filter((item) => !known.has(item.id))];
      state.digest = {
        ...state.digest,
        items: merged,
        sources: [...(state.digest?.sources || []).filter((s) => s.id !== 'reddit'), ...live.sources],
      };
      if (merged.length) setUpdated(`Live · ${timeAgo(live.generatedAt)}`);
      setNotice(message);
      render();
    } catch {
      setNotice(
        `${message} Reddit couldn't be reached from the browser either — the next scheduled collection will refresh this page.`
      );
    }
  }

  /* --------------------------------------------------------------- init */

  loadPrefs();
  document.querySelectorAll('.sort-chip').forEach((chip) => {
    chip.classList.toggle('is-on', chip.dataset.sort === state.sort);
    chip.addEventListener('click', () => {
      state.sort = chip.dataset.sort;
      document.querySelectorAll('.sort-chip').forEach((c) => c.classList.toggle('is-on', c === chip));
      savePrefs();
      renderGrid();
    });
  });
  $('refresh').addEventListener('click', load);
  load();
})();
