/**
 * Fixture tests for the collector's pure parts: source normalizers, the
 * cross-source ranking, and the email renderer. No network — run with:
 *   node art-digest/test/run.mjs
 */

import assert from 'node:assert/strict';
import { collectInlineImages } from '../send-email.mjs';
import {
  normalizeReddit,
  normalizeRedditRss,
  sampleShape,
  normalizeArtStation,
  artstationSize,
  normalizePixiv,
  normalizeDeviantArt,
  normalizeDeviantArtApi,
  normalizeBluesky,
  normalizeDanbooru,
  applyNsfwPolicy,
  harvestSubreddits,
  ADULT_SUBS,
  rankItems,
  resolveThumbnails,
  renderEmail,
  renderFeed,
} from '../collect.mjs';

let passed = 0;
const failures = [];
const pending = [];
const test = (name, fn) => {
  const run = async () => {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`  ✕ ${name}\n    ${err.message}`);
    }
  };
  pending.push(run);
};

const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const hoursAgo = (h) => (NOW - h * 3600_000) / 1000;

/* ------------------------------------------------------------------ reddit */

const redditPayload = {
  data: {
    children: [
      {
        data: {
          id: 'aaa111',
          title: 'Neon Harbour &amp; the Last Ferry',
          author: 'painterly',
          permalink: '/r/Art/comments/aaa111/neon_harbour/',
          score: 8421,
          created_utc: hoursAgo(5),
          subreddit_name_prefixed: 'r/Art',
          over_18: false,
          is_self: false,
          url_overridden_by_dest: 'https://i.redd.it/aaa111.jpg',
          preview: {
            images: [
              {
                source: { url: 'https://preview.redd.it/aaa111.jpg?width=1920&amp;s=abc' },
                resolutions: [
                  { url: 'https://preview.redd.it/aaa111.jpg?width=320&amp;s=d' },
                  { url: 'https://preview.redd.it/aaa111.jpg?width=640&amp;s=e' },
                  { url: 'https://preview.redd.it/aaa111.jpg?width=960&amp;s=f' },
                ],
              },
            ],
          },
        },
      },
      { data: { id: 'nsfw1', title: 'nope', author: 'x', permalink: '/p', score: 99999, over_18: true, created_utc: hoursAgo(1), preview: { images: [{ source: { url: 'https://preview.redd.it/n.jpg' } }] } } },
      { data: { id: 'text1', title: 'Weekly thread', author: 'mod', permalink: '/t', score: 500, is_self: true, stickied: true, created_utc: hoursAgo(2) } },
      { data: { id: 'noimg', title: 'A link post', author: 'y', permalink: '/l', score: 300, created_utc: hoursAgo(3), url_overridden_by_dest: 'https://example.com/article' } },
    ],
  },
};

test('reddit: keeps image posts, including adult ones, and flags them', () => {
  const items = normalizeReddit(redditPayload, 'Art');
  assert.equal(items.length, 2, 'self posts and posts with no image are still dropped');
  assert.deepEqual(items.map((i) => i.nsfw), [false, true], 'over_18 becomes the nsfw flag');
});

test('reddit: decodes entities in titles and image URLs', () => {
  const [item] = normalizeReddit(redditPayload, 'Art');
  assert.equal(item.title, 'Neon Harbour & the Last Ferry');
  assert.equal(item.image, 'https://preview.redd.it/aaa111.jpg?width=1920&s=abc');
  assert.ok(!item.thumb.includes('&amp;'), 'thumbnail URL is decoded');
  assert.equal(item.artist, 'u/painterly');
  assert.equal(item.url, 'https://www.reddit.com/r/Art/comments/aaa111/neon_harbour/');
  assert.equal(item.scoreLabel, '8.4k upvotes');
  assert.equal(item.context, 'r/Art');
});

const redditAtom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<entry>
  <author><name>/u/tuulikki</name></author>
  <id>t3_zz9001</id>
  <link href="https://www.reddit.com/r/Art/comments/zz9001/the_lighthouse/" />
  <updated>2026-09-11T07:30:00+00:00</updated>
  <title>The Lighthouse at Var</title>
  <content type="html">&lt;a href="https://i.redd.it/zz9001.jpg"&gt;&lt;img src="https://preview.redd.it/zz9001.jpg?width=640&amp;amp;s=x" alt="post"&gt;&lt;/a&gt;</content>
</entry>
<entry>
  <author><name>/u/nobody</name></author>
  <id>t3_zz9002</id>
  <link href="https://www.reddit.com/r/Art/comments/zz9002/text_post/" />
  <updated>2026-09-11T06:00:00+00:00</updated>
  <title>Discussion thread</title>
  <content type="html">&lt;p&gt;no image here&lt;/p&gt;</content>
</entry>
</feed>`;

test('reddit atom: reads the nsfw category when the JSON API is unavailable', () => {
  const feed = redditAtom.replace(
    '<title>The Lighthouse at Var</title>',
    '<category term="nsfw" label="NSFW" /><title>The Lighthouse at Var</title>'
  );
  const [item] = normalizeRedditRss(feed);
  assert.equal(item.nsfw, true);
  assert.equal(item.context, 'r/Art', 'the nsfw tag is not mistaken for the subreddit');
});

test('reddit atom: used when the JSON API refuses, ranked by feed position', () => {
  const items = normalizeRedditRss(redditAtom, 'Art');
  assert.equal(items.length, 1, 'entries without an image are dropped');
  const [item] = items;
  assert.equal(item.id, 'reddit:zz9001');
  assert.equal(item.title, 'The Lighthouse at Var');
  assert.equal(item.artist, 'u/tuulikki');
  assert.equal(item.url, 'https://www.reddit.com/r/Art/comments/zz9001/the_lighthouse/');
  assert.equal(item.image, 'https://preview.redd.it/zz9001.jpg?width=640&s=x');
  assert.equal(item.scoreLabel, '#1 top today in r/Art');
  assert.equal(item.postedAt, '2026-09-11T07:30:00.000Z');
});

test('reddit: a post from an adult subreddit is flagged even when the feed is silent', () => {
  // The Atom feed often omits the nsfw category, and a rule34 post labelled
  // SFW would slip straight past the widget's SFW filter.
  const feed = redditAtom
    .replace('/r/Art/comments/zz9001/the_lighthouse/', '/r/rule34/comments/zz9001/piece/')
    .replace('<title>The Lighthouse at Var</title>', '<category term="rule34" label="r/rule34" /><title>A perfectly ordinary title</title>');
  const [item] = normalizeRedditRss(feed);
  assert.equal(item.context, 'r/rule34');
  assert.equal(item.nsfw, true, 'the subreddit settles it');

  const [json] = normalizeReddit({
    data: { children: [{ data: {
      id: 'j1', title: 'no flag set', author: 'x', permalink: '/r/rule34/comments/j1/x/', score: 100,
      created_utc: hoursAgo(2), subreddit: 'rule34', over_18: false,
      preview: { images: [{ source: { url: 'https://preview.redd.it/j1.jpg' } }] },
    } }] },
  });
  assert.equal(json.nsfw, true, 'even when over_18 is somehow unset');
});

test('adult subreddits are only the ones declared', () => {
  assert.deepEqual([...ADULT_SUBS].sort(), ['ecchi', 'hentai', 'rule34']);
});

/* -------------------------------------------------------------- artstation */


test('artstation: reads the explore feed shape (square covers, no like counts)', () => {
  // Shape taken from a real trending response.
  const items = normalizeArtStation({
    data: [
      {
        id: 22861190,
        hash_id: '4193e2',
        url: 'https://www.artstation.com/artwork/4193e2',
        title: 'Leon S. Kennedy (fan art)',
        hide_as_adult: false,
        smaller_square_cover_url: 'https://cdna.artstation.com/p/assets/images/images/102/320/164/20260910144737/smaller_square/leon.jpg',
        small_square_cover_url: 'https://cdna.artstation.com/p/assets/images/images/102/320/164/20260910144737/small_square/leon.jpg',
        user: { username: 'he77ga', full_name: 'Olya Anufrieva' },
      },
      {
        id: 2,
        hash_id: 'second',
        url: 'https://www.artstation.com/artwork/second',
        title: 'Runner up',
        smaller_square_cover_url: 'https://cdna.artstation.com/p/assets/images/images/1/2/3/20260910144737/smaller_square/b.jpg',
        user: { username: 'two', full_name: 'Two' },
      },
    ],
  });

  assert.equal(items.length, 2);
  const [first, second] = items;
  assert.equal(first.artist, 'Olya Anufrieva');
  assert.equal(first.artistUrl, 'https://www.artstation.com/he77ga');
  assert.equal(first.url, 'https://www.artstation.com/artwork/4193e2');
  assert.ok(first.thumb.includes('/medium/leon.jpg'), 'the thumbnail is upsized from the square cover');
  assert.ok(first.image.includes('/large/leon.jpg'), 'the full image asks for the large render');
  assert.ok(
    first.thumbFallbacks.some((u) => u.includes('/small_square/leon.jpg')) &&
      first.thumbFallbacks.at(-1).includes('/smaller_square/leon.jpg'),
    'the given square covers stay as fallbacks, smallest last'
  );
  assert.equal(first.scoreLabel, '#1 trending', 'no like counts: the feed order is the score');
  assert.ok(first.value > second.value, 'earlier in the trending feed ranks higher');
});

test('artstation: keeps using like counts when the projects feed provides them', () => {
  const [item] = normalizeArtStation({
    data: [{
      hash_id: 'likes1',
      title: 'With likes',
      permalink: 'https://www.artstation.com/artwork/likes1',
      likes_count: 3120,
      user: { full_name: 'Mira Solis' },
      cover: { medium_image_url: 'http://cdna.artstation.com/p/medium.jpg', smaller_square_image_url: 'https://cdna.artstation.com/p/square.jpg' },
    }],
  });
  assert.equal(item.scoreLabel, '3.1k likes');
  assert.equal(item.value, 3120);
  assert.equal(item.image, 'https://cdna.artstation.com/p/medium.jpg', 'http is upgraded to https');
});

test('artstationSize: only rewrites a real size segment', () => {
  assert.equal(
    artstationSize('https://cdna.artstation.com/p/a/b/20260910/smaller_square/x.jpg', 'large'),
    'https://cdna.artstation.com/p/a/b/20260910/large/x.jpg'
  );
  assert.equal(artstationSize('https://example.com/plain.jpg', 'large'), 'https://example.com/plain.jpg');
  assert.equal(artstationSize('', 'large'), '');
});

test('artstation: keeps adult work and flags it', () => {
  const items = normalizeArtStation({
    data: [
      { hash_id: 'ok1', title: 'fine', url: 'https://www.artstation.com/artwork/ok1', smaller_square_cover_url: 'https://c/s/smaller_square/a.jpg', user: {} },
      { hash_id: 'adult1', title: 'adult', url: 'https://www.artstation.com/artwork/adult1', adult_content: true, smaller_square_cover_url: 'https://c/s/smaller_square/b.jpg', user: {} },
      { hash_id: 'adult2', title: 'hidden', url: 'https://www.artstation.com/artwork/adult2', hide_as_adult: true, smaller_square_cover_url: 'https://c/s/smaller_square/c.jpg', user: {} },
    ],
  });
  assert.deepEqual(items.map((i) => i.id), ['artstation:ok1', 'artstation:adult1', 'artstation:adult2']);
  assert.deepEqual(items.map((i) => i.nsfw), [false, true, true]);
});

/* ------------------------------------------------------------------- pixiv */

const pixivPayload = {
  contents: [
    {
      illust_id: 90210,
      title: '夜明けの街',
      user_name: 'kaze',
      user_id: 55,
      rank: 1,
      rating_count: 12480,
      view_count: 90000,
      illust_upload_timestamp: hoursAgo(20),
      illust_type: '0',
      url: 'https://i.pximg.net/c/240x480/img-master/img/2026/09/10/00/00/00/90210_p0_master1200.jpg',
      illust_content_type: { sexual: 0, grotesque: false },
    },
    { illust_id: 3, title: 'r18', user_name: 'z', rank: 2, rating_count: 99999, illust_type: '0', url: 'https://i.pximg.net/x.jpg', illust_content_type: { sexual: 2 } },
    { illust_id: 4, title: 'ugoira', user_name: 'z', rank: 3, rating_count: 50, illust_type: '2', url: 'https://i.pximg.net/y.jpg', illust_content_type: {} },
  ],
};

test('pixiv: keeps R-18 flagged, drops animations, proxies blocked thumbnails', () => {
  const items = normalizePixiv(pixivPayload, { pixivProxy: 'https://i.pixiv.re' });
  assert.equal(items.length, 2, 'ugoira is still skipped; the R-18 entry is kept');
  assert.deepEqual(items.map((i) => i.nsfw), [false, true]);
  const [item] = items;
  assert.equal(item.url, 'https://www.pixiv.net/artworks/90210');
  assert.equal(item.thumb, 'https://i.pixiv.re/c/240x480/img-master/img/2026/09/10/00/00/00/90210_p0_master1200.jpg');
  assert.ok(item.image.includes('/c/600x1200_90/'), 'the large image uses a bigger master size');
  assert.equal(item.scoreLabel, '12.5k bookmarks · #1 today');
});

test('pixiv: the R-18 ranking marks everything it returns as adult', () => {
  const items = normalizePixiv(
    { contents: [{ illust_id: 5, title: 'x', user_name: 'y', rank: 1, rating_count: 10, illust_type: '0', url: 'https://i.pximg.net/a.jpg', illust_content_type: {} }] },
    { pixivProxy: 'https://i.pixiv.re', nsfwRanking: true }
  );
  assert.equal(items[0].nsfw, true);
});

test('pixiv: an empty proxy drops thumbnails instead of shipping broken ones', () => {
  const [item] = normalizePixiv(pixivPayload, { pixivProxy: '' });
  assert.equal(item.thumb, '');
  assert.equal(item.image, '');
});

/* -------------------------------------------------------------- deviantart */

const deviantartXml = `<?xml version="1.0" encoding="utf-8"?>
<rss xmlns:media="http://search.yahoo.com/mrss/"><channel>
<item>
  <title>Ember Fox</title>
  <link>https://www.deviantart.com/aurelia/art/Ember-Fox-998877</link>
  <pubDate>Wed, 10 Sep 2026 21:15:00 PDT</pubDate>
  <media:credit role="author" url="https://www.deviantart.com/aurelia">Aurelia</media:credit>
  <media:content url="https://images-wixmp.com/full/ember.jpg" medium="image" width="1600" height="900"/>
  <media:thumbnail url="https://images-wixmp.com/t150/ember.jpg" width="150"/>
  <media:thumbnail url="https://images-wixmp.com/t400/ember.jpg" width="400"/>
  <media:rating>nonadult</media:rating>
</item>
<item>
  <title>Mature piece</title>
  <link>https://www.deviantart.com/x/art/Mature-1</link>
  <media:credit role="author">x</media:credit>
  <media:content url="https://images-wixmp.com/full/m.jpg" medium="image"/>
  <media:rating>adult</media:rating>
</item>
</channel></rss>`;

test('deviantart: parses the RSS feed and flags mature deviations', () => {
  const items = normalizeDeviantArt(deviantartXml);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.nsfw), [false, true]);
  const [item] = items;
  assert.equal(item.id, 'deviantart:998877');
  assert.equal(item.title, 'Ember Fox');
  assert.equal(item.artist, 'Aurelia');
  assert.equal(item.thumb, 'https://images-wixmp.com/t400/ember.jpg', 'largest thumbnail wins');
  assert.equal(item.scoreLabel, '#1 most popular');
  assert.ok(item.postedAt.startsWith('2026-09-11'), 'pubDate parsed to ISO');
});

test('deviantart api: normalizes daily deviations and flags mature ones', () => {
  const items = normalizeDeviantArtApi({
    results: [
      {
        deviationid: 'abc-123',
        title: 'Ember Fox',
        url: 'https://www.deviantart.com/aurelia/art/Ember-Fox-998877',
        is_mature: false,
        published_time: String(Math.floor(NOW / 1000) - 3600),
        author: { username: 'Aurelia' },
        preview: { src: 'https://images-wixmp.com/preview/ember.jpg' },
        content: { src: 'https://images-wixmp.com/full/ember.jpg' },
        stats: { favourites: 4210, comments: 88 },
      },
      { deviationid: 'm-1', title: 'Mature', url: 'https://www.deviantart.com/x/art/m-1', is_mature: true, author: { username: 'x' }, preview: { src: 'https://i/m.jpg' }, stats: { favourites: 99999 } },
      { deviationid: 'no-img', title: 'No image', url: 'https://www.deviantart.com/x/art/no-img', author: { username: 'x' }, stats: { favourites: 5 } },
    ],
  });
  assert.deepEqual(items.map((i) => i.id), ['deviantart:abc-123', 'deviantart:m-1']);
  assert.deepEqual(items.map((i) => i.nsfw), [false, true]);
  const [item] = items;
  assert.equal(item.artist, 'Aurelia');
  assert.equal(item.artistUrl, 'https://www.deviantart.com/Aurelia');
  assert.equal(item.image, 'https://images-wixmp.com/full/ember.jpg');
  assert.equal(item.thumb, 'https://images-wixmp.com/preview/ember.jpg');
  assert.equal(item.scoreLabel, '4.2k favourites');
  assert.equal(item.context, 'Daily Deviation');
  assert.ok(item.postedAt.startsWith('2026-09-11'));
});

/* ---------------------------------------------------------------- bluesky */

const blueskyPayload = {
  posts: [
    {
      uri: 'at://did:plc:abc/app.bsky.feed.post/3kxyz',
      author: { handle: 'mira.bsky.social', displayName: 'Mira Solis' },
      record: { text: 'Ashfall Cathedral. Finally finished!\nOils over a 3D block-in. #conceptart', createdAt: '2026-09-11T09:00:00.000Z' },
      embed: { images: [{ thumb: 'https://cdn.bsky.app/thumb/1.jpg', fullsize: 'https://cdn.bsky.app/full/1.jpg' }] },
      likeCount: 2410,
    },
    {
      uri: 'at://did:plc:def/app.bsky.feed.post/3kabc',
      author: { handle: 'inky.bsky.social' },
      // A quote-post with media nests the images one level deeper.
      embed: { media: { images: [{ thumb: 'https://cdn.bsky.app/thumb/2.jpg', fullsize: 'https://cdn.bsky.app/full/2.jpg' }] } },
      record: { text: 'late night sketch', createdAt: '2026-09-11T04:00:00.000Z' },
      likeCount: 180,
      labels: [{ val: 'nudity' }],
    },
    { uri: 'at://did:plc:ghi/app.bsky.feed.post/3knope', author: { handle: 'text.bsky.social' }, record: { text: 'no picture here' }, likeCount: 9000 },
  ],
};

test('bluesky: reads both embed shapes, titles from the post text, flags labels', () => {
  const items = normalizeBluesky(blueskyPayload, 'conceptart');
  assert.equal(items.length, 2, 'posts without an image are dropped');
  const [first, second] = items;
  assert.equal(first.title, 'Ashfall Cathedral', 'the first sentence becomes the title');
  assert.equal(first.artist, 'Mira Solis');
  assert.equal(first.url, 'https://bsky.app/profile/mira.bsky.social/post/3kxyz');
  assert.equal(first.thumb, 'https://cdn.bsky.app/thumb/1.jpg');
  assert.equal(first.context, '#conceptart');
  assert.equal(first.nsfw, false);
  assert.equal(second.artist, '@inky.bsky.social', 'falls back to the handle');
  assert.equal(second.thumb, 'https://cdn.bsky.app/thumb/2.jpg', 'quote-post media is found');
  assert.equal(second.nsfw, true, 'a nudity label marks the post adult');
});

/* --------------------------------------------------------------- danbooru */

test('danbooru: titles from character and series, credits the original source', () => {
  const items = normalizeDanbooru([
    {
      id: 7001,
      score: 312,
      fav_count: 640,
      rating: 'e',
      created_at: '2026-09-11T06:00:00.000Z',
      source: 'https://www.pixiv.net/artworks/149478161',
      tag_string_artist: 'kaze_(artist)',
      tag_string_character: 'ganyu_(genshin_impact)',
      tag_string_copyright: 'genshin_impact',
      large_file_url: 'https://cdn.donmai.us/sample/7001.jpg',
      preview_file_url: 'https://cdn.donmai.us/preview/7001.jpg',
    },
    { id: 7002, score: 120, rating: 'g', tag_string_artist: 'solo_artist', preview_file_url: 'https://cdn.donmai.us/preview/7002.jpg' },
    { id: 7003, score: 999, rating: 'q', is_deleted: true, preview_file_url: 'https://cdn.donmai.us/preview/7003.jpg' },
    { id: 7004, score: 888, rating: 'q', is_banned: true, preview_file_url: 'https://cdn.donmai.us/preview/7004.jpg' },
  ]);

  assert.deepEqual(items.map((i) => i.id), ['danbooru:7001', 'danbooru:7002'], 'deleted and banned posts are skipped');
  const [first, second] = items;
  assert.equal(first.title, 'ganyu (genshin impact)');
  assert.equal(first.artist, 'kaze');
  assert.equal(first.artistUrl, 'https://www.pixiv.net/artworks/149478161', 'links the artist\'s own posting when known');
  assert.equal(first.url, 'https://danbooru.donmai.us/posts/7001');
  assert.equal(first.scoreLabel, 'score 312 · 640 favourites');
  assert.equal(first.nsfw, true, 'explicit is adult');
  assert.equal(second.nsfw, false, 'general is not');
  assert.equal(second.artistUrl, 'https://danbooru.donmai.us/posts?tags=solo_artist', 'falls back to the artist tag');
});

/* ------------------------------------------------------- subreddit groups */

const SUBS = Array.from({ length: 26 }, (_, i) => `sub${i}`);
const fakeRun = (broken = [], log = []) => async (group) => {
  log.push(group.join('+'));
  const bad = group.find((sub) => broken.includes(sub));
  if (bad) {
    const err = new Error('HTTP 404 Not Found');
    err.status = 404;
    throw err;
  }
  return { items: group.map((sub) => ({ id: sub, context: `r/${sub}` })), fetched: group.length };
};

test('subreddits: one dead name is isolated by halving, not by asking one by one', async () => {
  const log = [];
  const result = await harvestSubreddits(SUBS, fakeRun(['sub19'], log), { pause: 0, backoff: 0 });
  assert.deepEqual(result.dropped, ['r/sub19 (not found)']);
  assert.equal(result.items.length, 25, 'every other subreddit still lands');
  assert.ok(result.requests <= 14, `isolated in ${result.requests} requests`);
  assert.ok(!result.budgetSpent);
});

test('subreddits: passing rate limiting is waited out, not split into more requests', async () => {
  // Reddit limits by request count, so a 429 must not immediately fan out.
  let calls = 0;
  const sizes = [];
  const run = async (group) => {
    sizes.push(group.length);
    calls++;
    if (calls === 1) {
      const err = new Error('HTTP 429 Too Many Requests');
      err.status = 429;
      throw err;
    }
    return { items: group.map((sub) => ({ id: sub })), fetched: group.length };
  };
  const result = await harvestSubreddits(SUBS.slice(0, 9), run, { pause: 0, backoff: 0, groupSize: 9 });
  assert.deepEqual(sizes, [9, 9], 'the same group is retried whole');
  assert.equal(result.items.length, 9, 'and it lands once the limit clears');
  assert.deepEqual(result.dropped, []);
});

test('subreddits: one subreddit that keeps refusing is found, not blamed on its group', async () => {
  // A group that fails past its retry is usually one bad member, not all nine.
  const sizes = [];
  const run = async (group) => {
    sizes.push(group.length);
    if (group.includes('sub5')) {
      const err = new Error('HTTP 429 Too Many Requests');
      err.status = 429;
      throw err;
    }
    return { items: group.map((sub) => ({ id: sub })), fetched: group.length };
  };
  const result = await harvestSubreddits(SUBS.slice(0, 9), run, { pause: 0, backoff: 0, groupSize: 9 });
  assert.deepEqual(result.dropped, ['r/sub5 (unreachable (429))'], 'only the one that refuses is dropped');
  assert.equal(result.items.length, 8, 'the other eight land');
  assert.equal(sizes[0], 9, 'the group is tried whole first');
  assert.equal(sizes[1], 9, 'and retried whole before any splitting');
  assert.ok(sizes.slice(2).every((n) => n < 9), 'only then does it halve');
  assert.ok(sizes.length <= 9, `isolated in ${sizes.length} requests, without re-retrying every half`);
});

test('subreddits: a dead name is separated from a throttled one', async () => {
  const run = async (group) => {
    if (group.includes('sub3')) {
      const err = new Error('HTTP 404 Not Found');
      err.status = 404;
      throw err;
    }
    if (group.includes('sub7')) {
      const err = new Error('HTTP 429 Too Many Requests');
      err.status = 429;
      throw err;
    }
    return { items: group.map((sub) => ({ id: sub })), fetched: group.length };
  };
  const result = await harvestSubreddits(SUBS.slice(0, 13), run, { pause: 0, backoff: 0, groupSize: 13, retries: 1 });
  assert.ok(result.dropped.includes('r/sub3 (not found)'), 'the 404 is named as gone');
  assert.ok(
    result.dropped.some((d) => d.includes('unreachable (429)')),
    'the throttled half is reported as unreachable, not as a bad name'
  );
  assert.ok(result.items.length >= 6, 'the reachable subreddits still land');
});

test('subreddits: every group is asked once before any group is asked twice', async () => {
  // The tail of the list must not be dropped unrequested because an earlier
  // group spent the budget being hunted down.
  const order = [];
  const run = async (group) => {
    order.push(group.join('+'));
    if (group.includes('sub0')) {
      const err = new Error('HTTP 429 Too Many Requests');
      err.status = 429;
      throw err;
    }
    return { items: group.map((sub) => ({ id: sub })), fetched: group.length };
  };
  const result = await harvestSubreddits(SUBS, run, { pause: 0, backoff: 0, groupSize: 9, budget: 6 });

  const firstPass = order.slice(0, 3);
  assert.equal(new Set(firstPass).size, 3, 'all three groups go out in the first pass');
  assert.ok(firstPass.some((g) => g.endsWith('sub25')), 'including the last one');
  assert.ok(
    result.items.some((i) => i.id === 'sub25'),
    'so the subreddits at the end of the list actually land'
  );
  assert.ok(
    !result.dropped.some((d) => d.includes('sub25')),
    'and are never dropped for a budget an earlier group spent'
  );
});

test('subreddits: a clean list costs one request per group', async () => {
  const log = [];
  const result = await harvestSubreddits(SUBS, fakeRun([], log), { pause: 0, backoff: 0 });
  assert.equal(result.requests, 3, '26 subreddits in groups of nine');
  assert.equal(result.items.length, 26);
  assert.deepEqual(result.dropped, []);
  assert.ok(log.every((group) => group.includes('+')), 'always multireddit requests');
});

test('subreddits: a hard wall is reported, never retried forever', async () => {
  let calls = 0;
  const throttled = async () => {
    calls++;
    const err = new Error('HTTP 429 Too Many Requests');
    err.status = 429;
    throw err;
  };
  const result = await harvestSubreddits(SUBS, throttled, { pause: 0, backoff: 0, budget: 5, groupSize: 9 });
  assert.equal(calls, 5, 'the request budget caps the damage');
  assert.ok(result.budgetSpent);
  assert.equal(result.dropped.length, 26, 'everything it could not reach is reported');
  assert.ok(
    result.dropped.every((d) => /budget spent|unreachable \(429\)/.test(d)),
    'and none of it is blamed on a bad name'
  );
});

test('subreddits: a slow day stops at the deadline, not at the budget', async () => {
  let clock = 0;
  let calls = 0;
  const slow = async () => {
    calls++;
    clock += 30_000; // every request burns half a minute before failing
    const err = new Error('HTTP 504 Gateway Timeout');
    err.status = 504;
    throw err;
  };
  const result = await harvestSubreddits(SUBS, slow, {
    pause: 0,
    backoff: 0,
    budget: 40,
    deadlineMs: 120_000,
    now: () => clock,
  });
  assert.ok(calls <= 6, `stopped after ${calls} requests rather than 40`);
  assert.ok(result.budgetSpent);
  assert.equal(result.dropped.length, 26);
});

test('ranking: adult work is neither boosted nor penalised', () => {
  // Same source, same age: the only thing separating them is the score.
  const mixed = [
    { ...makeItems('reddit', 1, 9000)[0], id: 'sfw-top', title: 'sfw top', artist: 'a', context: 'r/Art', nsfw: false, value: 9000 },
    { ...makeItems('reddit', 1, 9000)[0], id: 'nsfw-mid', title: 'nsfw mid', artist: 'b', context: 'r/rule34', nsfw: true, value: 5000 },
    { ...makeItems('reddit', 1, 9000)[0], id: 'sfw-low', title: 'sfw low', artist: 'c', context: 'r/painting', nsfw: false, value: 1000 },
  ];
  const ranked = rankItems({ reddit: mixed }, { limit: 3, windowHours: 48, now: NOW });
  assert.deepEqual(ranked.map((i) => i.id), ['sfw-top', 'nsfw-mid', 'sfw-low'], 'score alone decides the order');

  // Flip the scores and the adult piece leads, with nothing else changed.
  const flipped = mixed.map((item) => ({ ...item, value: item.nsfw ? 9000 : item.value === 9000 ? 5000 : 1000 }));
  const reranked = rankItems({ reddit: flipped }, { limit: 3, windowHours: 48, now: NOW });
  assert.equal(reranked[0].id, 'nsfw-mid', 'the most popular piece leads whatever it is');
  assert.equal(
    ranked.find((i) => i.id === 'nsfw-mid').heat,
    reranked.find((i) => i.id === 'sfw-top').heat,
    'the same score earns the same heat either way'
  );
});

/* ------------------------------------------------------------ nsfw policy */

test('nsfw policy: include keeps everything, exclude and only split it', () => {
  const items = [
    { id: 'a', nsfw: false },
    { id: 'b', nsfw: true },
    { id: 'c', nsfw: false },
  ];
  assert.deepEqual(applyNsfwPolicy(items).map((i) => i.id), ['a', 'b', 'c'], 'include is the default');
  assert.deepEqual(applyNsfwPolicy(items, 'include').map((i) => i.id), ['a', 'b', 'c']);
  assert.deepEqual(applyNsfwPolicy(items, 'exclude').map((i) => i.id), ['a', 'c']);
  assert.deepEqual(applyNsfwPolicy(items, 'only').map((i) => i.id), ['b']);
});

/* ----------------------------------------------------------------- ranking */

const makeItems = (source, n, base) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${source}:${i}`,
    source,
    title: `${source} piece ${i}`,
    artist: `artist ${i}`,
    artistUrl: '',
    url: `https://example.com/${source}/${i}`,
    image: 'https://example.com/i.jpg',
    thumb: 'https://example.com/t.jpg',
    value: base - i * 10,
    scoreLabel: `${base - i * 10} points`,
    postedAt: new Date(NOW - (i + 1) * 3600_000).toISOString(),
    context: '',
  }));

test('ranking: interleaves sources so one site cannot dominate', () => {
  const ranked = rankItems(
    { reddit: makeItems('reddit', 20, 9000), artstation: makeItems('artstation', 20, 400), pixiv: makeItems('pixiv', 20, 5000) },
    { limit: 12, windowHours: 48, now: NOW }
  );
  assert.equal(ranked.length, 12);
  const counts = ranked.reduce((acc, i) => ({ ...acc, [i.source]: (acc[i.source] || 0) + 1 }), {});
  assert.deepEqual(counts, { reddit: 4, artstation: 4, pixiv: 4 });
});

test('ranking: spreads a source across its subreddits before repeating one', () => {
  // r/Art has the loudest posts; without diversity it would take every slot.
  const fromSub = (sub, count, top) =>
    makeItems('reddit', count, top).map((item, i) => ({
      ...item,
      id: `${sub}-${i}`,
      title: `${sub} piece ${i}`,
      artist: `${sub} artist ${i}`,
      context: sub,
    }));
  const reddit = [...fromSub('r/Art', 8, 9000), ...fromSub('r/DnD', 3, 400), ...fromSub('r/ConceptArt', 3, 300)];
  const ranked = rankItems({ reddit }, { limit: 6, windowHours: 48, now: NOW });
  const subs = ranked.map((i) => i.context);
  assert.deepEqual(subs.slice(0, 3).sort(), ['r/Art', 'r/ConceptArt', 'r/DnD'], 'one from each before any repeat');
  assert.equal(new Set(ranked.map((i) => i.id)).size, 6, 'no duplicates');
});

test('ranking: drops anything older than the window', () => {
  const stale = makeItems('reddit', 3, 9000).map((i) => ({ ...i, postedAt: new Date(NOW - 200 * 3600_000).toISOString() }));
  const ranked = rankItems({ reddit: stale, pixiv: makeItems('pixiv', 2, 100) }, { limit: 10, windowHours: 48, now: NOW });
  assert.ok(ranked.every((i) => i.source === 'pixiv'), 'only fresh items survive');
});

test('ranking: keeps undated items (the source ordered them for us)', () => {
  const undated = makeItems('deviantart', 3, 30).map((i) => ({ ...i, postedAt: null }));
  const ranked = rankItems({ deviantart: undated }, { limit: 5, windowHours: 48, now: NOW });
  assert.equal(ranked.length, 3);
});

test('ranking: heat is 0-100 and the top post of each source scores highest', () => {
  const ranked = rankItems({ reddit: makeItems('reddit', 5, 9000) }, { limit: 5, windowHours: 48, now: NOW });
  assert.ok(ranked.every((i) => i.heat >= 0 && i.heat <= 100));
  assert.deepEqual([...ranked].sort((a, b) => b.heat - a.heat).map((i) => i.id), ranked.map((i) => i.id));
});

test('ranking: removes duplicate posts of the same piece', () => {
  const dupes = [...makeItems('reddit', 2, 100), ...makeItems('reddit', 2, 100)];
  const ranked = rankItems({ reddit: dupes }, { limit: 10, windowHours: 48, now: NOW });
  assert.equal(ranked.length, 2);
});

/* -------------------------------------------------------------- thumbnails */

test('thumbnails: a host that refuses us may still serve the reader', async () => {
  // The check runs from a datacenter; the reader does not. Refusing everything
  // must not empty the card — that lost every Danbooru image for four days.
  const items = [{ url: 'https://danbooru.donmai.us/posts/1', thumb: 'https://cdn.donmai.us/180x180/a.jpg', thumbFallbacks: ['https://cdn.donmai.us/original/a.jpg'], image: '' }];
  await resolveThumbnails(items, { check: async () => false });
  assert.equal(items[0].thumb, 'https://cdn.donmai.us/180x180/a.jpg', 'the image still ships');
  assert.equal(items[0].thumbVerified, false, 'flagged so the run can report it');
});

test('thumbnails: walks the candidate ladder down to one that resolves', async () => {
  const items = [
    {
      thumb: 'https://cdn/medium/a.jpg',
      thumbFallbacks: ['https://cdn/large/a.jpg', 'https://cdn/small_square/a.jpg', 'https://cdn/smaller_square/a.jpg'],
      image: 'https://cdn/large/a.jpg',
    },
    { thumb: 'https://cdn/medium/b.jpg', thumbFallbacks: [], image: 'https://cdn/large/b.jpg' },
    { thumb: 'https://cdn/good.jpg', thumbFallbacks: [], image: 'https://cdn/good-big.jpg' },
  ];
  const tried = [];
  await resolveThumbnails(items, {
    check: async (url) => {
      tried.push(url);
      return url.includes('good') || url.includes('small_square');
    },
  });
  assert.equal(items[0].thumb, 'https://cdn/small_square/a.jpg', 'the first resolving candidate wins');
  assert.equal(items[0].image, 'https://cdn/small_square/a.jpg', 'the big version follows the thumbnail');
  assert.ok(!tried.includes('https://cdn/smaller_square/a.jpg'), 'the ladder stops at the first hit');
  assert.equal(items[1].thumb, 'https://cdn/medium/b.jpg', 'nothing resolves: the best candidate ships anyway');
  assert.equal(items[1].thumbVerified, false, 'marked unverified rather than dropped');
  assert.equal(items[2].thumb, 'https://cdn/good.jpg', 'a working thumbnail is left alone');
});

test('thumbnails: the check is told which page the image belongs to', async () => {
  // Hotlink checks expect the image's own site as the referer, not a search
  // engine's — sending the wrong one is what lost every Danbooru thumbnail.
  const seen = [];
  await resolveThumbnails(
    [
      { url: 'https://danbooru.donmai.us/posts/7001', thumb: 'https://cdn.donmai.us/180x180/a.jpg', thumbFallbacks: [], image: '' },
      { url: 'not a url', thumb: 'https://cdn/b.jpg', thumbFallbacks: [], image: '' },
    ],
    {
      check: async (url, options) => {
        seen.push([url, options?.referer]);
        return true;
      },
    }
  );
  assert.deepEqual(seen[0], ['https://cdn.donmai.us/180x180/a.jpg', 'https://danbooru.donmai.us/']);
  assert.equal(seen[1][1], '', 'an unparseable link just means no referer, not a crash');
});

test('thumbnails: every item is checked even past the concurrency limit', async () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ thumb: `https://cdn/${i}.jpg`, thumbFallbacks: [], image: '' }));
  const seen = [];
  await resolveThumbnails(items, { concurrency: 3, check: async (url) => { seen.push(url); return false; } });
  assert.equal(seen.length, 20);
  assert.ok(items.every((i) => i.thumbVerified === false));
});

/* ---------------------------------------------------------- inline images */

const imageResponse = (bytes, type = 'image/jpeg') => ({
  ok: true,
  headers: new Map([['content-length', String(bytes)], ['content-type', type]]),
  arrayBuffer: async () => new Uint8Array(bytes).buffer,
});
// The real fetch returns Headers; a Map answers .get the same way.

test('inline images: downloads what it can and rewrites those cards to cid:', async () => {
  const items = [
    { id: 'a', url: 'https://danbooru.donmai.us/posts/1', thumb: 'https://cdn.donmai.us/a.jpg' },
    { id: 'b', url: 'https://www.reddit.com/r/Art/comments/b/', thumb: 'https://preview.redd.it/b.png' },
  ];
  const seen = [];
  const { attachments, srcFor, bytes } = await collectInlineImages(items, {
    fetchImpl: async (url, options) => {
      seen.push([url, options.headers.Referer]);
      return imageResponse(1024, url.endsWith('.png') ? 'image/png' : 'image/jpeg');
    },
  });

  assert.equal(attachments.length, 2);
  assert.equal(bytes, 2048);
  assert.deepEqual(seen[0], ['https://cdn.donmai.us/a.jpg', 'https://danbooru.donmai.us/']);
  assert.match(srcFor(items[0]), /^cid:art-1@/);
  assert.match(srcFor(items[1]), /^cid:art-2@/);
  assert.equal(attachments[1].type, 'image/png');
  assert.match(attachments[1].filename, /\.png$/);
});

test('inline images: a card whose image will not download keeps its remote URL', async () => {
  const items = [
    { id: 'ok', url: 'https://site/1', thumb: 'https://cdn/ok.jpg' },
    { id: 'refused', url: 'https://site/2', thumb: 'https://cdn/refused.jpg' },
    { id: 'gone', url: 'https://site/3', thumb: 'https://cdn/boom.jpg' },
    { id: 'none', url: 'https://site/4', thumb: '' },
  ];
  const { attachments, srcFor } = await collectInlineImages(items, {
    fetchImpl: async (url) => {
      if (url.includes('refused')) return { ok: false, status: 403, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
      if (url.includes('boom')) throw new Error('connection reset');
      return imageResponse(512);
    },
  });
  assert.equal(attachments.length, 1, 'only the one that downloaded is attached');
  assert.match(srcFor(items[0]), /^cid:/);
  assert.equal(srcFor(items[1]), '', 'the refused card falls back to its URL');
  assert.equal(srcFor(items[2]), '', 'and so does the one that threw');
  assert.equal(srcFor(items[3]), '');
});

test('inline images: oversized and non-image responses are skipped, and the total is capped', async () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ id: `i${i}`, url: 'https://site/x', thumb: `https://cdn/${i}.jpg` }));
  const { attachments, bytes } = await collectInlineImages(items, {
    maxBytes: 1000,
    totalBytes: 2000,
    fetchImpl: async (url) => {
      if (url.endsWith('0.jpg')) return imageResponse(5000); // too big on its own
      if (url.endsWith('1.jpg')) return imageResponse(400, 'text/html'); // not an image
      return imageResponse(900);
    },
  });
  assert.deepEqual(attachments.map((a) => a.cid.split('@')[0]), ['art-3', 'art-4'], 'the oversized and the non-image are skipped');
  assert.ok(bytes <= 2000, 'and the run stops at the total cap');
});

/* ------------------------------------------------------------------- email */

test('email: renders every item, escapes markup, and links the widget', () => {
  const digest = {
    generatedAt: new Date(NOW).toISOString(),
    totalCollected: 90,
    sourceLabels: { reddit: 'Reddit', pixiv: 'Pixiv' },
    sources: [
      { id: 'reddit', label: 'Reddit', status: 'ok', kept: 8 },
      { id: 'pixiv', label: 'Pixiv', status: 'failed', kept: 0 },
    ],
    nsfwCount: 1,
    items: [
      { ...makeItems('reddit', 1, 900)[0], title: '<script>alert(1)</script>', heat: 91, context: 'r/Art' },
      { ...makeItems('pixiv', 1, 900)[0], heat: 80, thumb: '', image: '', nsfw: true },
    ],
  };
  const html = renderEmail(digest, { siteUrl: 'https://example.com/art-digest/' });
  assert.ok(html.includes('&lt;script&gt;'), 'titles are escaped');
  assert.ok(!html.includes('<script>'), 'no raw script tag survives');
  assert.ok(html.includes('1. Reddit · r/Art'));
  assert.ok(html.includes('✕ Pixiv'), 'failed sources are reported');
  assert.ok(html.includes('https://example.com/art-digest/'));
  assert.ok(html.includes('· 18+'), 'adult picks are labelled');
  assert.ok(html.includes('1 marked 18+'), 'the header counts them');
  assert.equal((html.match(/<tr>\s*<td style="padding:0 0 18px 0;">/g) || []).length, 2);
});

/* ----------------------------------------------------------- diagnostics */

test('sampleShape: trims a raw row to something loggable', () => {
  const shape = sampleShape({
    id: 7,
    title: 'x'.repeat(200),
    tags: [1, 2, 3],
    cover: { thumb_url: 'https://a/b.jpg', nested: { deep: true } },
    flag: false,
  });
  assert.equal(shape.id, 7);
  assert.ok(shape.title.endsWith('…') && shape.title.length < 100, 'long strings are cut');
  assert.equal(shape.tags, '[3]');
  assert.equal(shape.cover.thumb_url, 'https://a/b.jpg');
  assert.equal(shape.cover.nested, '{…}', 'nesting stops at one level');
  assert.equal(shape.flag, false);
});

// Run in declaration order so the output reads top to bottom.
for (const run of pending) await run();

/* -------------------------------------------------------------------- feed */

test('feed: one item per artwork, with the image and the 18+ marker', () => {
  const digest = {
    generatedAt: new Date(NOW).toISOString(),
    sourceLabels: { reddit: 'Reddit', danbooru: 'Danbooru' },
    items: [
      { id: 'reddit:a', source: 'reddit', title: 'Kyudo & Ink', artist: 'u/painterly', url: 'https://www.reddit.com/r/Art/comments/a/', thumb: 'https://preview.redd.it/a.jpg', heat: 94, scoreLabel: '9k upvotes', context: 'r/Art', postedAt: new Date(NOW - 3600_000).toISOString(), nsfw: false },
      { id: 'danbooru:b', source: 'danbooru', title: 'piece', artist: 'someone', url: 'https://danbooru.donmai.us/posts/2', thumb: '', heat: 80, scoreLabel: 'score 200', context: 'original', postedAt: null, nsfw: true },
    ],
  };
  const xml = renderFeed(digest, { siteUrl: 'https://example.com/', feedUrl: 'https://example.com/data/feed.xml' });

  assert.equal((xml.match(/<item>/g) || []).length, 2, 'one entry per piece, not per day');
  assert.ok(xml.includes('<title>Kyudo &amp; Ink — u/painterly</title>'), 'titles are escaped');
  assert.ok(xml.includes('<guid isPermaLink="false">reddit:a</guid>'), 'a stable guid keeps read state');
  assert.ok(xml.includes('<media:content url="https://preview.redd.it/a.jpg"'), 'the image is offered to the reader');
  assert.ok(xml.includes('[18+] piece'), 'adult pieces say so in the title');
  assert.ok(!xml.includes('<media:content url=""'), 'an item with no image omits the tag');
  assert.ok(xml.includes('<atom:link href="https://example.com/data/feed.xml"'), 'the feed points at itself');
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
