# Taco Music

An installable web player (PWA) for the Taco Music live stream.

- **Stream:** `https://icecast.tacogroup.uk/stream`
- **Now playing feed:** `https://icecast.tacogroup.uk/nowplaying/nowplaying.json`

- **Lyrics:** looked up per song from [LRCLIB](https://lrclib.net) (free, no API key). Synced
  lyrics highlight and scroll along with the song.

These are set at the top of `app.js`.

**Keeping lyrics and the progress bar in time:** the feed gives each song's start time and the
server's current time, so the app corrects for a device clock that's off. While playing, it
measures how far behind live the listener is from the player's buffer, plus Icecast's
burst-on-connect (`BURST_SECONDS`). Before playback starts it assumes `DEFAULT_LISTEN_DELAY`.

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | The player |
| `manifest.webmanifest` | App name, colours and icons for installing |
| `sw.js` | Service worker: caches the app so it opens instantly and offline |
| `fonts/` | Bricolage Grotesque, the display font, bundled so it works offline (SIL Open Font License, see `fonts/OFL.txt`) |
| `icons/` | `logo.svg` is the Taco logo; `icon.svg` and `icon-maskable.svg` put it on the orange background, and the PNGs are rendered from those |

## Hosting

Any static web host works, as long as it serves the site over **HTTPS**, which browsers
require before they offer "Install app". Serve the files as they are; no build step is needed.

After changing the app files, bump `CACHE` in `sw.js` (for example `taco-music-v2`) so
installed copies pick up the new version.
