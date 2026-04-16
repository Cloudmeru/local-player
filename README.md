# Local Player

A desktop video player built with **Electron**, **Plyr**, and **hls.js** — featuring rich movie/series metadata, sprite thumbnail previews, and a polished dark/light UI.

![Local Player](logo.svg)

---

## Download

| Platform | Link |
|----------|------|
| Windows  | [⬇ LocalPlayer-Setup.exe](https://github.com/Cloudmeru/local-player/releases/latest/download/LocalPlayer-Setup.exe) |
| macOS    | [⬇ LocalPlayer.dmg](https://github.com/Cloudmeru/local-player/releases/latest/download/LocalPlayer.dmg) |
| Linux    | [⬇ LocalPlayer.AppImage](https://github.com/Cloudmeru/local-player/releases/latest/download/LocalPlayer.AppImage) |

> No admin rights required — installs per-user. FFmpeg is **bundled** — no extra software needed. Get all releases [here](https://github.com/Cloudmeru/local-player/releases).

---

## Features

- 🎬 **Multi-format playback** — MP4, MKV, AVI, WebM, MOV, TS, FLV, WMV, M4V, M3U8 (HLS)
- 🖼️ **Sprite thumbnail previews** — hover the seek bar to preview frames (generated via FFmpeg)
- 🔍 **Automatic metadata** — fetches poster, synopsis, cast, rating, genre from **TMDb** and **Letterboxd**
- 🎨 **Dark & Light theme** — modern UI with smooth animations
- 📂 **Folder library** — browse and manage your local video collection
- 💾 **Watch history** — remembers playback position per file
- ⚙️ **Configurable API keys** — TMDb and Letterboxd credentials stored in user settings

---

## Requirements

- [Node.js](https://nodejs.org/) 18+ *(for development only)*

> **End users don't need anything.** FFmpeg is bundled inside the installer.

### Optional API Keys

| Provider   | Env Variable / Setting         | Purpose                  |
|------------|-------------------------------|--------------------------|
| TMDb       | `TMDB_API_KEY`                | Movie/series metadata    |
| Letterboxd | `LETTERBOXD_CLIENT_ID` + `LETTERBOXD_CLIENT_SECRET` | Extended metadata |

---

## Getting Started

```bash
# Clone the repo
git clone https://github.com/Cloudmeru/local-player.git
cd local-player

# Install dependencies
npm install

# Run in development
npm start
```

---

## Build

```bash
# Windows (NSIS installer)
npm run build:win

# macOS (DMG)
npm run build:mac

# Linux (AppImage)
npm run build:linux
```

Output is placed in the `dist/` folder.  
The Windows build produces a **per-user NSIS installer** — no admin rights required.

---

## Tech Stack

| Layer       | Library                                      |
|-------------|----------------------------------------------|
| Shell       | [Electron](https://www.electronjs.org/) v41  |
| Player      | [Plyr](https://plyr.io/) 3.7                 |
| HLS         | [hls.js](https://github.com/video-dev/hls.js)|
| Fonts       | Plus Jakarta Sans (Google Fonts)             |
| Thumbnails  | FFmpeg (sprite sheet generation)             |
| Metadata    | TMDb API, Letterboxd API                     |
| Installer   | electron-builder + NSIS                      |

---

## License

MIT
