# The Pattern

An offline audiobook player themed on the Wheel of Time novels. It runs in Chrome on your iPhone and keeps every book on the device itself.

## How it works

There are two ways audio gets onto the phone, and both end with the same thing: a copy sitting in the app's own IndexedDB storage, playing with no network connection needed and nothing uploaded anywhere once it's there.

- **Directly**, through the Files app picker on the phone.
- **From the PC**, via the `server/` app running on your desktop. Drag files into its library page, it merges chapters and re-encodes only when actually needed, and stores the result on `D:\Audiobooks`. The phone's **My Computer** tab reaches that server over a Cloudflare tunnel (`books.banquetscaler.com`) and downloads whichever book you tap. See [`server/README.md`](server/README.md) for that half.

## Importing a whole audiobook

Two shapes of audiobook both end up as a single book with a real chapter list:

- **One big file.** Pick a single `.m4b` or `.mp3` and the app reads the chapter marks embedded in it. A 20-hour book with 50 chapters becomes one entry with 50 chapters you can tap between. The audio is stored once and chapters are seek points inside it, so switching chapters is instant with no reloading.
- **A folder of files.** Select every chapter file at once. They are sorted naturally, so `01`, `02`, `10` land in the right order rather than `1`, `10`, `2`.

Chapter marks are read from three places, covering nearly everything in circulation: MP4 `chpl` (Nero style), the QuickTime chapter track that ffmpeg and most taggers write, and ID3v2 `CHAP` frames in mp3. If a file has no marks it simply becomes a single chapter.

## Supported formats

Effectively everything except DRM.

On import each file is handed to the audio engine to see whether it genuinely decodes. That is the only reliable test, since `canPlayType` reports "maybe" for plenty of things Safari then refuses to play. Each file gets a badge:

- **Ready** plays natively and is stored untouched. Covers mp3, m4a, m4b, aac, wav, aiff, caf, flac, and Opus or Vorbis on newer iOS.
- **Convert** cannot be decoded here, so it is transcoded to AAC once during import. Covers wma, ape, wv, mpc, tta, shn, ra, amr, ac3, dts, dsf, au, and audio tracks inside video files like mkv, avi, wmv, and mov.
- **DRM** is an Audible `.aa` or `.aax`. These are encrypted and no browser can play them, so they are skipped with a message rather than failing silently.

Conversion runs entirely on your phone using a bundled build of ffmpeg. Nothing is uploaded. The converter is about 32MB and is only fetched the first time you import something that actually needs it, so if you only ever add mp3 and m4b it is never downloaded. After first use it is cached and works offline.

Converted audio is written as mono 64kbps AAC, transparent for narration and usually several times smaller than the original. A long book in an exotic format can take a few minutes, so keep the app in the foreground while it works.

## Features

- Resume exactly where you left off, per book, across app restarts
- Playback speed from 0.75x to 3x, remembered per book
- Chapter list with tap to jump, plus previous and next chapter
- Back 15s and forward 30s, rolling across chapter boundaries instead of stopping at the edge
- Auto-advance through chapters, whether they are separate files or marks inside one file
- Sleep timer: 5 to 60 minutes, or stop at the end of the current chapter
- Lock screen and Control Center controls via the Media Session API
- Storage meter showing how much of the device quota the library uses
- Each book is bound to one of the seven Ajahs, which sets its colour
- **My Computer** tab: browse and download books straight from the PC library server, no cable or Wi-Fi transfer dance needed

## Getting it onto your iPhone

The app needs HTTPS for offline mode and home screen install. Opening the HTML file directly from Files will not give you those.

**GitHub Pages**, from this folder:

```powershell
.\deploy-github.ps1
```

The script commits, pushes, enables Pages, and prints the URL. Re-run it any time to publish changes. It creates a **public** repo, since free GitHub Pages requires one; `ACCOUNTS.txt` is excluded from both the repo and the zip.

**Or Netlify Drop**, no account needed: drag `AudiobookPlayer-deploy.zip` onto https://app.netlify.com/drop.

**Then, on your iPhone:** open that URL in Chrome and bookmark it, or add it to the home screen.

A note on browsers: the player works the same in Chrome as in Safari, because every iOS browser is required to use Apple's WebKit engine underneath. Audio format support, storage, and the converter all behave identically.

What differs is installation. Installing a web app to the home screen as a real standalone app is Safari-only on iOS; Chrome's shortcut opens back inside Chrome. That also means the library does not get the protected persistent storage an installed home-screen app receives, so iOS is more willing to clear it under heavy storage pressure or long disuse. Regular use keeps it alive, but keep your original files on the PC rather than treating the phone as the only copy.

## Getting books onto the phone

Open the **My Computer** tab in the app. First time, it asks for the PC server's address -- open the desktop library page (see [`server/README.md`](server/README.md)) and copy the link under "Connect your phone." After that, every book on the PC shows up there with a Download button.

The PC server runs continuously in the background (a scheduled task, `AudiobookServer`) alongside the Cloudflare tunnel (`AudiobookTunnel`) that exposes it, so this works whenever the PC is on -- nothing to launch by hand.

## Storage notes

- Audio lives in IndexedDB on the device. A typical phone allows several GB.
- The app requests persistent storage on launch, which iOS grants to home screen web apps.
- Deleting a book removes its audio immediately.
- Clearing Safari website data erases the library, so keep your original files somewhere.

## Running it locally

From the `Claude Apps` folder:

```bash
npx --yes http-server AudiobookPlayer -p 8123 -c-1
```

Service workers are allowed on localhost, so PWA behaviour can be tested there. If a change does not show up, the service worker is serving a cached copy: bump `CACHE` in `sw.js` or unregister the worker in the develop menu.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Library view, player view, import modal, and the Wheel emblem |
| `style.css` | Dark leather and gilt theme, sized for iPhone with safe area insets |
| `app.js` | Storage, playback, chapter handling, sleep timer, Media Session |
| `metadata.js` | Reads embedded chapter marks from MP4 and ID3 files |
| `computer.js` | The My Computer tab: talks to the PC server, downloads books |
| `sw.js` | Service worker caching the app shell for offline launch |
| `manifest.json` | PWA metadata for the home screen install |
| `icons/` | Wheel icons, including a maskable variant |
| `vendor/ffmpeg/` | Bundled ffmpeg.wasm used to convert formats iOS cannot play |
| `server/` | The PC-side library server -- not published, see its own README |

### A note on `vendor/ffmpeg`

These files must stay next to each other and be served from the same origin. Browsers refuse to start a Worker from a cross-origin script, so running ffmpeg off a CDN does not work. The library's own workaround, its `classWorkerURL` option, is broken in 0.12.10: it spawns the worker as a module, and module workers have no `importScripts`, so loading the core always fails. Left alone it resolves the worker next to `ffmpeg.js`, which is why these are vendored rather than linked.

`ffmpeg-core.wasm` is 32MB and accounts for nearly all of the folder size. It is never sent to the browser unless a conversion is actually needed.
