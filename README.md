# Taco Music

An installable web player (PWA) for the Taco Music live stream.

- **Stream:** `https://icecast.tacogroup.uk/stream`
- **Now playing feed:** `https://icecast.tacogroup.uk/nowplaying/nowplaying.json`

- **Lyrics:** shown in the Lyrics tab and in a full-screen view (opened from the line shown under
  the song title on phones, or the expand button on the tab), with the cover blurred behind them.
  The line being sung sits a third of the way down and the others fade with distance; backing
  vocals in brackets are set smaller; instrumental breaks and intros of 5 s or more show three dots
  that fill in until singing resumes. Looked up per song from [LRCLIB](https://lrclib.net) (free, no API key), reading
  each record's [Lyricsfile](https://lrclib.net/lyricsfile) where it has one, with LRC and plain
  text as fallbacks. Songs with word timings light up word by word; others highlight line by line.
  Timed lyrics are only used when LRCLIB's recording is within `SYNC_TOLERANCE` seconds of the
  length the feed gives for the playing file. If only other versions have timings, the words show
  without following along. Requests identify the app with `LRCLIB_CLIENT` and wait out
  LRCLIB's `Retry-After` when it's busy.

- **Song requests:** the Request tab searches `https://icecast.tacogroup.uk/nowplaying/library.json`
  and sends requests to `https://icecast.tacogroup.uk/requests`, which queues them in the AutoDJ.
  Upcoming requests come back in the feed's `requests` list. The server enforces the rules
  (a wait between requests per listener, no duplicates, nothing played in the last 30 minutes,
  and a maximum queue length).

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
| `manifest.webmanifest` | App name, colours and icons for installing |
| `sw.js` | Service worker: always loads the latest app, and keeps a copy so it opens offline |
| `vendor/js-yaml.min.js` | [js-yaml](https://github.com/nodeca/js-yaml) 4.1.0, reads Lyricsfile YAML (MIT License, see `vendor/js-yaml.LICENSE.txt`) |
| `fonts/` | Bricolage Grotesque, the display font, bundled so it works offline (SIL Open Font License, see `fonts/OFL.txt`) |
| `icons/` | `logo.svg` is the Taco logo; `icon.svg` and `icon-maskable.svg` put it on the orange background, and the PNGs are rendered from those |

## Hosting

Any static web host works, as long as it serves the site over **HTTPS**, which browsers
require before they offer "Install app". Serve the files as they are; no build step is needed.

After changing the app files, bump `CACHE` in `sw.js` (for example `taco-music-v2`) so
installed copies pick up the new version.
