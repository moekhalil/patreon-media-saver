# Patreon Media Saver

Desktop app (Electron) to browse your Patreon memberships, watch/listen to posts, and download
**video** (Mux HLS via yt-dlp) and/or **audio** (the podcast's own `post_file` mp3) into local folders.

## Run

```powershell
npm install
# If npm's script policy skipped Electron's postinstall (electron.exe missing):
node node_modules\electron\install.js
npm start
```

Build a portable exe (optional): `npm run dist` → `dist\`.

## Icon

The logo source is [`src/assets/icon.svg`](src/assets/icon.svg). After editing it, run `npm run icons` to regenerate:

- `src/assets/icon.png`: the window/taskbar icon at runtime
- `build/icon.ico` (16–256 px) and `build/icon.png`: used by electron-builder for the exe icon

## Logging in

- **Log in with Patreon** opens Patreon's real login page in an app window. Enter your email/password
  and the emailed code there. The session cookie is kept in the app's own persistent session
  (`persist:patreon`), so you stay logged in.
- **Fallback:** paste a `Cookie:` header (e.g. from DevTools → "Copy as fetch") into the login screen.

## Downloading

- Video: yt-dlp with `--continue --no-overwrites`, Patreon `Origin`/`Referer` headers (like the old
  `Save-PatreonMedia`), merged/remuxed to `.mp4`. The post is re-fetched right before downloading, so
  expired Mux tokens get refreshed.
- Subtitles: the video's `post_file.transcript_url` (VTT) is embedded into the video as a soft
  subtitle track with ffmpeg (streams are copied, nothing is re-encoded). Re-checking an
  already-downloaded video adds subtitles to it if it doesn't have them yet. You can turn this off in
  Settings, or also keep a separate `.vtt` file.
- Audio: the podcast post's mp3 is downloaded directly (resumable). If an episode only has video,
  audio can optionally be extracted from it (`Settings → audio from video fallback`).
- Video and audio posts with the same title are grouped into one episode row (toggle in the toolbar).
- File names default to the post title with `:` → ` -` (e.g. `P213 - Human Waste.mp4`). The
  template supports `{title} {date} {campaign} {id} {type}`.

## Folders

- **Global folder** (Settings), optionally with a per-creator subfolder, e.g. `F:\PODCASTS\chapotraphouse`.
- **Per-creator override:** "Change…" in the creator header, e.g. map Chapo Trap House → `F:\PODCASTS\chapotraphouse`.

## Third-party tools

`yt-dlp.exe`, `ffmpeg.exe` and `ffprobe.exe` are downloaded automatically on first start into
`third-party\` (the project root in dev, next to the exe when packaged). Nothing is installed
globally. Reinstall or update them from Settings.

Settings are stored as JSON in `%APPDATA%\Patreon Media Saver\settings.json`.
