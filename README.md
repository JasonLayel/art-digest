# 🎨 Daily Digital Art Digest

A small widget that collects the most popular **new** digital art from
**ArtStation**, **Reddit** (two dozen art subreddits), **Pixiv**,
**DeviantArt**, **Bluesky** and **Danbooru**, ranks it into one list, and sends
it to you.

Live page: <https://JasonLayel.github.io/art-digest/>

## How it works

```
GitHub Actions (daily)          this repo                      you
┌──────────────────┐   commit   ┌─────────────────┐   read    ┌──────────────────┐
│ collect.mjs      │ ─────────► │ data/latest.json│ ────────► │ /art-digest/ page│
│ 4 sources → rank │            │ data/email.html │           └──────────────────┘
└────────┬─────────┘            └─────────────────┘
         │  send-email.mjs (SMTP)                              ┌──────────────────┐
         └───────────────────────────────────────────────────► │ your inbox       │
                                                               └──────────────────┘
```

The collection runs in CI rather than in your browser because ArtStation,
Pixiv and DeviantArt don't allow cross-origin reads, and because a static page
can't wake itself up once a day. The widget only reads the committed JSON, so
it stays a plain static page with no server, no build and no API keys.

| File | Purpose |
| --- | --- |
| `collect.mjs` | Fetches all four sources, normalizes, ranks, writes `data/` |
| `send-email.mjs` | Sends the digest over SMTP (no dependencies) |
| `taste.json` | What the digest leans toward: weighted keywords, artists, contexts, and mutes |
| `tools/merge-taste.mjs` | Folds gallery likes into `taste.json` |
| `tools/probe-artstation.mjs`, `tools/probe-pinterest.mjs` | Ask a source what it will answer without credentials |
| `index.html`, `digest.css`, `digest.js` | The widget: filterable gallery of the current digest |
| `test/run.mjs` | Fixture tests for the parsers, ranking and email template |
| `test/smtp.mjs` | Mail round-trip against a throwaway local SMTP server |
| `data/latest.json` | The current digest (written by CI) |
| `data/email.html` | The same digest as a ready-to-send HTML email |
| `data/feed.xml` | The same digest as an RSS feed, one entry per artwork |
| `data/archive/*.json` | One snapshot per day |

## Sources

| Source | Endpoint | Popularity signal |
| --- | --- | --- |
| ArtStation | community trending explore feed | position in the trending feed (the feed carries no like counts), or likes when the projects feed answers |
| Reddit | `top?t=day` across the subreddits below | upvotes, or feed position on the Atom fallback |
| Pixiv | daily illustration ranking (plus the R-18 ranking with a session cookie) | bookmarks |
| DeviantArt | Daily Deviations (API) or `boost:popular max_age:24h in:digitalart` RSS | favourites, or position in the feed |
| Bluesky | `searchPosts` over the art hashtags, public AppView, no credentials | likes |
| Your subjects | ArtStation search, one query per subject your profile names | likes, or feed position |
| Danbooru | `order:score age:1d` | score and favourites |

### Subreddits

Fetched as one multireddit request per group of nine. Reddit rate-limits by
request count, so the number of requests matters more than their size.

Groups go out breadth-first: every group is asked for once before any group is
asked for twice. Depth-first meant that isolating one bad name early in the
list could spend the whole budget, and the subreddits at the end were dropped
without ever being requested — a scheduling accident that read as a judgement
about those subreddits.

The two failure modes are handled differently:

- **404** — a name in the group is gone. The group is halved and each half
  retried until the bad name is alone, then dropped and reported.
- **429 or worse** — usually Reddit refusing traffic, so the *same* group is
  retried after a pause; splitting first would only send more requests, which
  is what once made 14 live subreddits look dead. If the retry doesn't clear
  it either, it is one subreddit refusing rather than all of Reddit, and the
  group is halved to find it.

Every drop is reported in the digest with its reason, and the run is capped at
30 requests and four minutes.

r/battlemaps is not in the list: it answers `429` to every anonymous feed
request, and isolating it costs enough requests to starve the groups behind it.
Reddit OAuth credentials may reach it — add it back with
`ART_DIGEST_EXTRA_SUBS=battlemaps` if you set them.

| Group | Subreddits |
| --- | --- |
| Fine art | r/Art, r/DigitalArt, r/painting, r/ImaginaryBestOf |
| Concept art | r/ConceptArt, r/SpecArt, r/SciFiArt, r/FantasyArt, r/ImaginaryTechnology, r/ImaginaryArchitecture |
| Tabletop & character art | r/characterdrawing, r/DnD, r/DungeonsAndDragons, r/Pathfinder_RPG, r/Warhammer40k |
| Fandom | r/FanArt, r/ImaginaryCharacters, r/ImaginaryMonsters, r/ImaginaryWesteros, r/AnimeSketch, r/awwnime |
| Worlds | r/ImaginaryLandscapes, r/ImaginaryCityscapes, r/ImaginaryMythology, r/ImaginaryWildlands |
| Adult art | r/rule34, r/hentai, r/ecchi |

`ART_DIGEST_EXTRA_SUBS=foo,bar` adds to this list; `ART_DIGEST_SUBS=foo,bar`
replaces it entirely. Within Reddit's share of the digest, each subreddit gets a
pick before any subreddit gets a second one, so r/Art can't crowd out the
niche ones.

### Adult work

Adult work is **kept and flagged**, not filtered out: every item carries
`nsfw: true|false`, the widget shows an `18+` badge with an
Everything / SFW / 18+ filter and an optional blur, and the email labels each
adult pick. `ART_DIGEST_NSFW=exclude` drops them instead; `only` keeps nothing
else.

Flagging changes how a piece is *labelled*, never how it is ranked. Adult work
gets no boost and no penalty: it is scored against its source's top piece like
everything else, and takes a slot in the same one-pick-per-subreddit rotation.
r/rule34 reaches the digest on the days its top post out-scores the top posts
of r/Art, r/DnD and the rest, and doesn't on the days it doesn't.

Reddit's Atom feed does not reliably carry the per-post nsfw category, so posts
from the adult subreddits are flagged by subreddit as well. `ART_DIGEST_NSFW_SUBS`
adds more names to that set.

What each source actually returns:

| Source | Adult work |
| --- | --- |
| Reddit | `over_18` posts included and flagged. On the Atom fallback the flag comes from the feed's nsfw category, which is less reliable than the JSON API's |
| Danbooru | `questionable` and `explicit` ratings flagged |
| DeviantArt | mature deviations requested from the API and flagged |
| Bluesky | posts labelled porn / sexual / nudity / graphic-media flagged |
| ArtStation | adult work is flagged, but the logged-out explore feed rarely carries any |
| Pixiv | the R-18 ranking is only served to a logged-in session — set `PIXIV_SESSION` to your own `PHPSESSID` cookie to include it |

Adult/NSFW posts are filtered out of every source. A source that fails is
reported in the digest and in the widget footer instead of failing the run —
the others still ship. A source that answers but whose rows no longer
normalize is reported as `changed`, with a trimmed sample row saved in the
digest so the shape can be fixed without guessing.

### Access from CI

These sites treat datacenter IPs (which is what GitHub's runners are) very
differently from a home connection:

| Source | Without credentials, from CI |
| --- | --- |
| Pixiv | works (all-ages ranking only) |
| ArtStation | works |
| Bluesky | the public AppView answers `403` to GitHub's runners; set `BLUESKY_IDENTIFIER` and `BLUESKY_APP_PASSWORD` (an [app password](https://bsky.app/settings/app-passwords), not your account password) for a signed-in route |
| Danbooru | works |
| Reddit | the JSON API answers `403 Blocked`; the collector falls back to the Atom feed, which works but has no vote counts. Set `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` (a *script* app at <https://www.reddit.com/prefs/apps>) to get the real API and real upvote counts |
| DeviantArt | `403` on every RSS host. Set `DEVIANTART_CLIENT_ID` / `DEVIANTART_CLIENT_SECRET` (register at <https://www.deviantart.com/developers/apps>) and the collector uses the official Daily Deviations API instead |

Both are repository secrets (*Settings → Secrets and variables → Actions*) and
both are optional — the digest ships with whatever sources answer.

### Thumbnails

Thumbnails are checked before the digest ships, because the email cannot retry
a broken image the way the widget can. The check runs from CI, though, and the
reader does not: a CDN that refuses a datacenter will serve a browser or
Gmail's proxy perfectly well. So a candidate that fails verification is marked
`thumbVerified: false` and shipped anyway rather than dropped — dropping it is
what quietly cost every Danbooru image for four days.

### Asking for what you like, not only sorting it

A profile can only re-rank what was collected, and most of these sources cannot
carry a given subject at all — Pixiv's ranking and Danbooru are anime and
fandom art whatever your profile says. So the profile also drives collection:
its heaviest keywords become ArtStation searches, and those results arrive as
their own source with their own share of the digest.

ArtStation is the only source where this is possible, and only through search.
Its `channel` and `medium` parameters are decoration — every channel returns
the unfiltered trending feed verbatim, and two different channels return
identical rows. `tools/probe-artstation.mjs` checks for exactly that, because a
parameter that is quietly ignored answers 200 with a full page of results and
looks like it works.

### Taste

`taste.json` tilts the digest toward what you like. It holds weighted
`keywords`, `artists` and `contexts` (a subreddit, hashtag or fandom), plus a
`mute` list. Edit it by hand — GitHub's web editor works fine on a phone — or
let the gallery write to it.

Matching runs against a piece's title, artist, context and tags together. An
artist you have named counts for three times a keyword, because naming an
artist is deliberate while a word can turn up by accident; a phrase must appear
whole; a single word must match a whole word, so `art` matches "fan art" but
not "ArtStation". Anything on the `mute` list is dropped outright.

**Taste changes which piece represents a source, not how many slots that source
gets.** The round-robin is untouched, so a profile sharpens the selection
without narrowing the range. A perfect match is worth `ART_DIGEST_TASTE_WEIGHT`
heat points (40 by default), which means something far more popular still wins
— this stays a digest of what is popular, tuned toward you. Raise the weight if
you would rather taste led.

Every pick records what it matched, so the gallery can say why it is there.

#### Teaching it

The gallery is a static page with nowhere to POST to, so the ♡ on each card
stores likes in your browser, and **Teach the digest** opens a prefilled issue
containing them. Submitting it runs `.github/workflows/taste.yml`, which folds
the likes into `taste.json` and closes the issue.

Tags count for a full point, words from a title for half, and every weight tops
out at 10 so one enthusiasm cannot swamp the profile. Because this repo is
public and anyone can open an issue, the workflow only reads issues opened by
the repository owner, and the merge takes only the fields it understands with
every field length-capped.

### Ranking

Upvotes, likes and bookmarks aren't the same currency, so each piece is scored
against the top piece *of its own source* (80%) plus a freshness bonus (20%),
giving a 0–100 "heat". The final list is then filled round-robin across the
sources so one busy site can't take over the digest.

## Running it yourself

```sh
node collect.mjs     # writes data/
node test/run.mjs    # fixture tests, no network

python3 -m http.server 8000     # then open /art-digest/
```

| Env var | Default | Purpose |
| --- | --- | --- |
| `ART_DIGEST_LIMIT` | `24` | How many pieces to keep |
| `ART_DIGEST_WINDOW_HOURS` | `48` | How new "new" has to be |
| `ART_DIGEST_SUBS` | see above | Comma-separated subreddits, replacing the default list |
| `ART_DIGEST_EXTRA_SUBS` | unset | Comma-separated subreddits to add to the default list |
| `ART_DIGEST_TAGS` | conceptart, characterart, dnd, fanart, digitalart | Bluesky hashtags to search |
| `ART_DIGEST_SOURCES` | all | Comma-separated source ids to run (`artstation,reddit,pixiv,deviantart,bluesky,danbooru`) |
| `ART_DIGEST_NSFW` | `include` | `include`, `exclude` or `only` |
| `ART_DIGEST_TASTE_WEIGHT` | `40` | Heat points a perfect taste match is worth |
| `ART_DIGEST_NSFW_SUBS` | unset | Subreddits whose every post should be flagged adult, added to r/rule34, r/hentai and r/ecchi |
| `PIXIV_SESSION` | unset | A Pixiv `PHPSESSID` cookie, which unlocks the R-18 daily ranking |
| `BLUESKY_IDENTIFIER` / `BLUESKY_APP_PASSWORD` | unset | A handle and app password, used when the public AppView refuses the request |
| `ART_DIGEST_PIXIV_PROXY` | `https://i.pixiv.re` | Pixiv blocks hotlinked thumbnails, so they're re-served through a mirror. Set to empty to drop Pixiv thumbnails instead |
| `ART_DIGEST_OUT` | `data` | Output directory |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | unset | Optional. Reddit blocks datacenter IPs on the public JSON API; with these set the collector uses app-only OAuth instead |
| `DEVIANTART_CLIENT_ID` / `DEVIANTART_CLIENT_SECRET` | unset | Optional. Without them DeviantArt is unreachable from CI; with them the collector reads Daily Deviations from the official API |

## Schedule

`.github/workflows/digest.yml` runs the collector every day at 13:05 UTC,
commits `data/` when it changes, and attaches the digest to the run. GitHub
only runs `schedule:` triggers from the **default branch**, so the daily run
starts once this workflow is merged to `master`; until then use *Actions → Art
digest → Run workflow*, or push a change to `collect.mjs`.

## Getting it emailed

`send-email.mjs` sends the digest over SMTP with no dependencies and no
third-party action holding your credentials. The workflow runs it after each
scheduled or manual collection; without credentials it prints a preview and
succeeds, so nothing breaks until you turn it on.

To turn it on, add these repository secrets
(*Settings → Secrets and variables → Actions*):

| Secret | Value |
| --- | --- |
| `DIGEST_SMTP_USER` | the sending address, e.g. `you@gmail.com` |
| `DIGEST_SMTP_PASS` | an [app password](https://myaccount.google.com/apppasswords) — never your account password |
| `DIGEST_TO` | optional; defaults to `DIGEST_SMTP_USER` |

Any SMTP host works: set `DIGEST_SMTP_HOST` / `DIGEST_SMTP_PORT` (defaults
`smtp.gmail.com` and `465`, implicit TLS).

```sh
node send-email.mjs --dry-run   # print the message instead of sending
node send-email.mjs             # send, if the credentials are set
```

`data/email.html` is also written on every run, so any other mailer can pick it
up as a message body:

```sh
curl -s https://raw.githubusercontent.com/JasonLayel/art-digest/main/data/email.html
```

## Subscribing in a reader

`data/feed.xml` is a standard RSS feed with one entry per artwork, so a reader
tracks what you have seen piece by piece. Readers fetch the images themselves,
over your own connection, which is why the feed can link them where the email
has to carry them.

## Tests

```sh
node test/run.mjs    # parsers, ranking, thumbnails, email template

# mail round-trip against a throwaway TLS server
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=localhost \
  -keyout /tmp/certs/key.pem -out /tmp/certs/cert.pem
CERT_DIR=/tmp/certs node test/smtp.mjs
```

Both run in CI before every collection.
