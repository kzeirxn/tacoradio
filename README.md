# Taco Music

An installable web player (PWA) for the Taco Music live stream.

- **Stream:** `https://icecast.tacogroup.uk/stream` (128 kbps), and `/stream-low` (64 kbps) for the data saver
- **Now playing feed:** `https://icecast.tacogroup.uk/nowplaying/nowplaying.json`

- **Lyrics:** shown in the Lyrics tab and in a full-screen view (opened from the line shown under
  the song title on phones, or the expand button on the tab), with the cover blurred behind them.
  The line being sung sits a third of the way down and the others fade with distance; backing
  vocals in brackets are set smaller; instrumental breaks and intros of 5 s or more show three dots
  that fill in until singing resumes. Lyrics come from [SyncLRC](https://synclrc.dev)
  (`SYNCLRC_API`): word-by-word (karaoke) timings where it has them, with background vocals as their
  own smaller lines, otherwise line-by-line timings or just the words. Timings are only used for a
  recording within `SYNC_TOLERANCE` seconds of the length the feed gives for the playing file; for
  another version, the words show without following along.
- **Held words glow:** as on Apple Music, a word sung for a second or more (`LONG_WORD`) lights up
  letter by letter, each letter lifting a little, with a soft glow in the cover's colour that builds
  while it's held and fades over `GLOW_FADE` seconds after. Not for listeners who ask for reduced
  motion.
- **Staying within SyncLRC's limit:** SyncLRC allows each listener 30 requests a minute, so the app
  keeps under `SYNCLRC_LIMIT` (25), queueing anything over it until there's room. Each song is asked
  about at most three times: by its title, once more without notes like "(Remastered 2011)" if that
  found nothing, and once more after `KARAOKE_RETRY_MS` if the word timings weren't ready (asking
  can set SyncLRC fetching them). What it finds is remembered on the device for a week (songs it
  has nothing for, for 6 hours), so a song that comes round again isn't asked about. If SyncLRC
  answers "too many requests", the app leaves it alone for `SYNCLRC_PAUSE_MS`.

- **Song requests:** the Request tab searches `https://icecast.tacogroup.uk/nowplaying/library.json`
  and sends requests to `https://icecast.tacogroup.uk/requests`, which queues them in the AutoDJ.
  Upcoming requests come back in the feed's `requests` list. The server enforces the rules
  (a wait between requests per listener, no duplicates, nothing played in the last 30 minutes,
  and a maximum queue length).

- **Likes:** the heart beside the song title likes the playing song (`/requests/like`). Each
  device sends an anonymous random id so its like counts once; counts arrive live with the
  timing updates. The **Top** tab shows the most liked, played and requested songs
  (`/requests/charts`).
- **Your request is playing:** the app remembers which songs this listener requested and shows a
  message when one starts, and a notification if the app is in the background and the listener
  allowed it.
- **Sleep timer:** 15, 30 or 60 minutes; then it fades out over 8 seconds and stops.
- **Share:** the share sheet (or a copied link) with the playing song and the station's address.
- **Data saver:** automatic (the 64 kbps stream on mobile data or with the browser's data saver
  on), always on, or off. Changing it while playing switches streams straight away. If the server
  doesn't have the small stream, the normal one is used.
- **Visualiser:** bars on the cover, in its colour, where the app plays the stream through Media
  Source (not on iPhones and iPads, where routing audio through Web Audio would stop background
  playback), and not for listeners who ask for reduced motion.
- **Live DJs and jingles:** a live DJ shows with a badge and no progress bar, and their songs' lyrics
  as words only (a DJ's song can start anywhere); a station ident shows as the station.
- **Station admin** (`admin.js`, loaded only when opened from the ⋯ menu or at `#admin`): sign in
  with the admin password set on the server, then skip the song or end a DJ's set, reorder,
  remove or add requests, see who's listening, upload songs and jingles, and see stats: totals, the
  most listeners at once each hour for the last week, daily peaks and top songs. Uploads take any
  number of files (or a whole folder), three at a time, in pieces of 4 MB (under 1 MB if a proxy
  turns big pieces away); the server turns away duplicates. Each added song is then checked on
  SyncLRC from the admin's browser, within the same limit as the lyrics, so a big batch is checked
  over a few minutes; each row says what was found, and the summary counts songs without timed lyrics.
- **Look:** a dark, glassy layout, two columns on wide screens. The colours come from the playing
  song's cover (an accent and two tints, with the cover blurred behind everything); with no cover,
  the station's own aqua and iris (`BRAND_THEME`). The data saver and the admin page sit in the ⋯
  menu at the top.

These are set at the top of `app.js`.

**Keeping lyrics and the progress bar in time:** the feed gives each song's exact start time
and the server's clock, and the app works out how far behind the broadcast the listener is hearing.

- **Playback:** where the browser supports Media Source Extensions for MP3 (Chrome, Edge and
  Android do), the app downloads the stream itself and feeds it to the player. Playback starts within
  about a second, instead of the 7 to 8 seconds Chrome otherwise collects first. Because the app
  knows when each piece of the stream arrived, it knows exactly which moment of the broadcast is
  playing, including after network stalls.
- **iPhone and iPad** keep the plain player, so audio carries on in the background. There the app
  times how long the player took to start (less the connection time, measured from the feed
  requests) and adds any time spent waiting for data.
- **Clock:** the device's clock is lined up with the server's from the quickest of the last 30
  live updates, or without them the freshest of the last 20 feed readings.
- **Live updates:** the request service streams the playing song's elapsed and remaining time with
  the server's clock every second (`/requests/live`, server-sent events), and pushes song changes
  and new requests the moment they happen. The app keeps its clock in line with each update.
  Without it, the app checks the feed every 2 seconds (`POLL_MS`), and twice a second around the
  end of a song.

Measured against a test stream with beeps at known moments, the lyrics clock is within about
0.15 s of what's heard, on both kinds of player and after network stalls. `STREAM_LATENCY` is
the measured time for audio to get from the AutoDJ to listeners; `DEFAULT_LISTEN_DELAY` is used
when the app isn't playing.

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | The player |
| `admin.js` | The station admin page, loaded when it's opened |
| `manifest.webmanifest` | App name, colours and icons for installing |
| `sw.js` | Service worker: always loads the latest app, and keeps a copy so it opens offline |
| `fonts/` | Bricolage Grotesque, the display font, bundled so it works offline (SIL Open Font License, see `fonts/OFL.txt`) |
| `icons/` | `logo.svg` is the Taco logo; `icon.svg` and `icon-maskable.svg` put it on the aqua-to-iris gradient, and the PNGs are rendered from those |

## Hosting

Any static web host works, as long as it serves the site over **HTTPS**, which browsers
require before they offer "Install app". Serve the files as they are; no build step is needed.

After changing the app files, bump `CACHE` in `sw.js` (for example `taco-music-v2`) so
installed copies pick up the new version.
