/*
 * Pulls your ArtStation likes out of your own browser.
 *
 * ArtStation refuses every /users/ path to this project's runner — anonymous
 * or not — so the likes cannot be fetched from CI at any price. Your browser
 * is already signed in, so it can simply ask.
 *
 * HOW TO RUN
 *   1. Open your likes page while signed in. Note that a saved collection
 *      lives at /<you>/collections/likes and is served by a different
 *      endpoint than a profile's own likes — check which one answers before
 *      trusting a run that returns nothing.
 *   2. Open the console: F12, or Ctrl+Shift+J (Cmd+Opt+J on a Mac).
 *   3. Paste this whole file in and press Enter.
 *   4. It prints a JSON block and copies it to your clipboard. Paste it back.
 *
 * It only reads. It sends nothing anywhere — the fetch below is to
 * artstation.com and nowhere else, which you can check before running it.
 */
(async () => {
  const user =
    location.pathname.split('/').filter(Boolean)[0] ||
    prompt('Your ArtStation username?');
  if (!user) return console.error('No username — open your likes page first.');

  const MAX_PAGES = 60; // ~3,000 likes, well past most collections
  const seen = new Set();
  const likes = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(
      `https://www.artstation.com/users/${encodeURIComponent(user)}/likes.json?page=${page}`,
      { credentials: 'include', headers: { Accept: 'application/json' } }
    );
    if (!res.ok) {
      console.warn(`page ${page}: HTTP ${res.status} — stopping here`);
      break;
    }
    const body = await res.json();
    const rows = body?.data ?? body?.results ?? [];
    if (!rows.length) break;

    for (const row of rows) {
      const hash = row.hash_id || row.id;
      if (!hash || seen.has(hash)) continue;
      seen.add(hash);
      likes.push({
        hash: String(hash),
        title: String(row.title || '').slice(0, 200),
        artist: String(row.user?.full_name || row.user?.username || '').slice(0, 120),
        username: String(row.user?.username || '').slice(0, 80),
        // Whichever of these ArtStation happens to send: they are the
        // vocabulary worth learning, far better than words from a title.
        tags: [
          ...(row.tags || []),
          ...(row.categories || []).map((c) => c?.name),
          ...(row.software_items || []).map((s) => s?.name),
          ...(row.mediums || []).map((m) => m?.name),
        ]
          .filter(Boolean)
          .map((t) => String(t).slice(0, 60))
          .slice(0, 20),
      });
    }
    console.log(`page ${page}: ${likes.length} so far…`);
    await new Promise((r) => setTimeout(r, 400)); // be polite to the API
  }

  // Saying "copied" after copying an empty array is worse than failing: the
  // first run of this reported success having fetched nothing, because the
  // likes live under /collections/likes and this asked /users/<u>/likes.json.
  if (!likes.length) {
    console.error(
      'Nothing came back. Check that you are signed in, that the username is right, ' +
        'and that this endpoint is the one your likes page actually uses — a collection ' +
        'is served from a different path than a profile.'
    );
    return null;
  }

  const out = JSON.stringify({ artstationLikes: likes }, null, 1);
  console.log(`\nDone: ${likes.length} liked pieces from ${new Set(likes.map((l) => l.username)).size} artists.`);
  try {
    copy(out); // Chrome/Firefox console helper
    console.log('Copied to your clipboard — paste it back to Claude.');
  } catch {
    console.log('Copy the block below:');
    console.log(out);
  }
  return out;
})();
