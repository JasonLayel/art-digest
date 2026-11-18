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
| ArtStation | community trending explore feed | position in the trending feed (the feed carries no like counts, and no dates either — see below) |
| Reddit | `top?t=day` across the subreddits below | upvotes, or feed position on the Atom fallback |
| Pixiv | daily illustration ranking (plus the R-18 ranking with a session cookie) | bookmarks |
| Danbooru | `order:score age:1d` | score and favourites |
| Your subjects | ArtStation search, `sorting=likes`, one query per subject | position among the most-liked for that subject |

### Why Reddit keeps losing subreddits

Reddit throttles anonymous datacenter traffic, and it shows: across the last
thirty days **6.7 subreddits a day** were dropped to HTTP 429, on 29 of those
30 days. The ones in the taste profile suffer most — r/ImaginaryCityscapes was
dropped on 36 of 61 days.

The collector already prefers an authenticated route and falls back to the
public JSON and then the Atom feed. It just has no credentials. Giving it some
is the single biggest quality win available:

1. Create a **script** app at <https://www.reddit.com/prefs/apps> (free).
2. Add the repository secrets `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET`.

That lifts the ceiling from "whatever Reddit feels like serving an anonymous
runner" to roughly 100 requests a minute, and the drops largely stop.

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

### What ArtStation will and will not tell us

ArtStation is the one source here that publishes no dates at all. Every row it
returns — trending, latest, search alike — carries exactly these fields:

```
hash_id, hide_as_adult, icons, id, is_highlighted,
small_square_cover_url, smaller_square_cover_url, title, url, user
```

No upload date, no like count, no view count. Six routes to a date have been
tried and all six are closed:

| route | result |
| --- | --- |
| `explore/projects/trending.json` | serves, no date field |
| `explore/projects/latest.json` | serves, no date field |
| `search/projects.json` | serves, no date field |
| `/projects/<hash>.json` | 403 |
| `api/v2/…/explore/projects/<hash>.json` | 500 |
| `/artwork/<hash>` as HTML (JSON-LD, og:, article:published_time) | 403, 12 of 12 |

The last one is the telling one: the page a person opens in a browser is gated
the same way the project JSON is, so this is not an API oversight — ArtStation
does not serve dates to anyone it does not recognise. An ArtStation piece can
be ranked by where the site itself puts it, and by nothing else.

Its `channel` and `medium` parameters are decoration: every channel returns the
unfiltered trending feed verbatim, and two different channels return identical
rows. `?sorting=latest` is ignored the same way. Search is the one *parameter*
it honours, and `explore/projects/latest.json` the one alternative *path* —
that one shares none of its fifty rows with trending and turned over seven of
them in 150 seconds while trending turned over none, so it is genuinely ordered
by upload.

Two things follow, and both are load-bearing:

- **The taste profile no longer drives ArtStation collection.** It used to, via
  search. But search orders the whole archive by relevance, and its rows are
  undated, so it surfaced an eleven-year-old piece at #6. Dropping undated
  search results is the only honest rule, and it drops every one of them — the
  source was running four requests a day to throw away everything it collected.
  It is gone. The profile still re-ranks everything every source returns.
- **ArtStation picks are labelled `date unknown`,** in the gallery and the
  email, and earn no freshness points (see below). They are in the digest
  because ArtStation is featuring them, which is a real signal — just not a
  signal about age.

`tools/probe-artstation.mjs` and `tools/probe-artstation-churn.mjs` reproduce
every measurement above. They exist because a parameter that is quietly ignored
answers 200 with a full page of results and looks exactly like one that works.

### Asking ArtStation for a subject

ArtStation's trending feed is whatever the whole site is looking at, which is
mostly anime and game character art. Architecture, environments, 3D and
semi-realistic character work only reach the digest if they are asked for by
name — and search is the one parameter ArtStation honours. `tools/probe-artstation-search.mjs`
checks the rest against a `page=2` control:

| asked for | result |
| --- | --- |
| `&query=` on search | **works** — eight subjects returned eight disjoint sets |
| `&sorting=likes` | **works** — 23 of 50 shared with relevance, and holds still across samples |
| `&sorting=date` | different set, but whether it orders by upload is **unproven** |
| `&sort_by=date`, `&medium=3d` | 49/50 shared — effectively ignored |
| `&order=date` | 50/50 — ignored |
| `&query=`, `&channel=`, `&medium=` on the *latest* feed | 50/50 — all ignored |

So the subject source uses `sorting=likes`, the one ordering that is both real
and demonstrably what its name says. `sorting=date` looked promising — it
returns a completely different fifty rows — but the churn test cannot confirm
it: "environment concept art" holds ~41,000 pieces from about fifteen years,
roughly one upload every few hours, so a date-ordered query would sit perfectly
still across a 150-second sample exactly as a non-date-ordered one does. Until
that is settled nothing from this source claims to be new, and it earns no
freshness credit.

What keeps it from repeating is the archive. Top-rated work does not change, so
every piece the digest has already shown is skipped and each run walks one step
further down each subject's ranking. Not "new to the internet", which ArtStation
will not tell us — "new to you", which the archive can prove.

Change the subjects with `ART_DIGEST_SUBJECTS`:

```sh
ART_DIGEST_SUBJECTS='brutalist architecture,3d character,mech design' node collect.mjs
```

### Importing your ArtStation likes

ArtStation refuses every `/users/` path to this project — anonymous or signed
in, from CI or from a sandbox — so the likes cannot be fetched here at any
price. A browser that is already signed in can simply ask, which makes the
whole credential question moot.

```sh
# 1. open https://www.artstation.com/<you>/likes, signed in
# 2. paste tools/grab-artstation-likes.js into the browser console
# 3. it copies a JSON block to your clipboard
node tools/merge-artstation-likes.mjs likes.json taste.json
```

Nothing is sent anywhere by that snippet: the only `fetch` in it is to
artstation.com, which you can check before running it.

Likes are the strongest signal this profile can take. They are deliberate,
they accumulated over years, and an ArtStation **tag** is vocabulary the artist
chose rather than a word scraped off a title — which matters, because titles
matched 53 picks in sixty-one days. So a tag is worth a full point, an artist
a point per piece you liked of theirs, and a title word a quarter and only
where there are no tags at all.

It merges rather than replaces, unlike a calibration. Likes say what you want;
only a rating session says what you turned **down**, so the contexts, mutes and
source shares a calibration produced all survive.

It also prints the tags that recur across your likes, which are far better
grounded as ArtStation search subjects than any list guessed from a
description:

```
ART_DIGEST_SUBJECTS='environment design,character design,...'
```

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

#### Calibrating it

The profile this repo shipped with was guessed from a couple of probes, and
sixty-one days of digests judged it: **93% of 1,464 picks matched none of it**,
and only 3.6% matched on subject. Two sources told the story —

| | picks | matched the profile |
| --- | --- | --- |
| Reddit | 391 | 60 (15%) |
| ArtStation | 388 | 41 (11%) |
| Pixiv | 378 | 1 (0%) |
| Danbooru | 306 | 0 (0%) |

Pixiv and Danbooru took 47% of every digest and matched once in two months,
because the round-robin gives every source the same share whether or not it can
carry your subjects. More keywords were never going to fix that: ArtStation
titles are "Marsh Fortress", not "architecture", which is why keyword matching
fired on 53 picks in sixty-one days.

So `calibrate.html` asks about real pieces instead. `tools/build-calibration.mjs`
draws a sample from the archive — equal shares per source, and within a source
one pick per context before any repeats — and the page shows them one at a time
to keep or skip. It runs on the same origin as the gallery, so hearts already
sitting in `localStorage` are read straight out of it and counted as keeps
rather than asked about again.

What the answers produce:

- **A share per source**, which is the lever that matters: `0` drops a source
  from collection, `2` doubles its slots. A source is only dropped on real
  evidence — asked about at least four times and kept none — because that is
  how a whole medium disappears.
- **Contexts** you kept, weighted by how many times, not just how reliably. A
  context covering nearly all of its source's ratings is skipped: ArtStation
  files everything under "Trending", and weighting that would boost the source
  twice.
- **Subjects** from the titles you kept, minus any word that also showed up on
  a skip, and only words appearing in two kept titles — one appearance is noise.
- **Mutes**, for a context asked about at least twice and kept zero times.

The result is shown in full before anything is sent, because dropping a source
is not something to discover later. Sending opens the same kind of prefilled
issue as the hearts do; `tools/merge-taste.mjs` tells the two apart and a
calibration **replaces** the profile rather than adding to it — merging into a
profile the evidence says is wrong keeps it wrong.

Rebuild the sample whenever you want a fresh set:

```sh
node tools/build-calibration.mjs 60
```

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

**Freshness is paid on evidence.** Anything dated older than the 48-hour window
is dropped outright. Everything else falls into one of three cases:

- **It has a timestamp.** Scored on its actual age.
- **It has no timestamp but comes from a feed that turns over daily** —
  ArtStation trending is the only one — and is scored as roughly a day old.
  Membership in today's trending feed is itself an observation about now: the
  six pieces picked from it were different every single day across five days of
  archive, while its top fifty held still over 150 seconds. It turns over daily,
  so being in it dates a piece about as well as a timestamp would. Items say so
  with `freshBy: 'feed'`, so no other undated source can quietly inherit the
  credit.
- **Neither.** Scored on popularity alone, no freshness at all.

That third case used to be the only case: *every* undated item was handed the
age of a piece halfway through the window. That is how an eleven-year-old
ArtStation search result scored 93 and landed sixth.

Cards from the second case still read **date unknown**, because that is true —
the credit is for the feed's behaviour, not for knowing when the piece was
made.

Round-robin is untouched by any of this: every source still gets the same share
of the 24 slots. This only governs what a pick may claim about itself.

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

## Getting told on your phone

There is no email. It was never read and is gone, along with the SMTP client
and the inline-image machinery.

Instead the daily run pushes a notification through [ntfy](https://ntfy.sh),
which needs no account at either end:

1. Install the ntfy app and subscribe to a topic only you know — treat the name
   like a password, because anyone holding it can push to your phone.
2. Add it as the repository secret `ART_DIGEST_NTFY_TOPIC`.

The message carries the top pick's title and artist, how many of today's picks
landed on your subjects, the first thumbnail, and a tap that opens the gallery.
It also names any source that has stopped answering — the failure that
otherwise goes unnoticed for a month, as Bluesky's did.

With no topic set it prints what it would have sent and the run carries on, so
a notification can never break a digest.

```sh
node tools/notify.mjs            # dry run against the last digest
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
