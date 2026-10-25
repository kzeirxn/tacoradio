# Taco Music

An installable web player (PWA) for the Taco Music live stream.

- **Stream:** `https://icecast.tacogroup.uk/stream`
- **Now playing feed:** `https://icecast.tacogroup.uk/nowplaying/nowplaying.json`

- **Lyrics:** looked up per song from [LRCLIB](https://lrclib.net) (free, no API key). Synced
  lyrics highlight and scroll along with the song.

These are set at the top of `app.js`, along with `LISTEN_DELAY`: how many seconds listeners
hear the stream behind the feed. Raise it if titles and lyrics run ahead of the music, and
lower it if they lag behind.

## Files

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | The player |
| `manifest.webmanifest` | App name, colours and icons for installing |
| `sw.js` | Service worker: caches the app so it opens instantly and offline |
| `icons/` | `logo.svg` is the Taco logo; `icon.svg` and `icon-maskable.svg` put it on the orange background, and the PNGs are rendered from those |

## Hosting

Any static web host works, as long as it serves the site over **HTTPS**, which browsers
require before they offer "Install app". Serve the files as they are; no build step is needed.

After changing the app files, bump `CACHE` in `sw.js` (for example `taco-music-v2`) so
installed copies pick up the new version.
