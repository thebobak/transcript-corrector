# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # start the server (http://localhost:3000)
node --watch server.js  # dev mode with auto-restart on file changes
```

No build step, no tests, no linter configured.

## Architecture

Two files do everything:

**`server.js`** — Express proxy on port 3000. Serves `public/` as static files and exposes two POST endpoints:
- `/api/correct` — text-only correction: sends SRT chunks directly to Claude with prompt caching on the system prompt.
- `/api/correct-audio` — audio-guided correction: (1) converts any audio/video format to 64 kbps mono 16 kHz MP3 chunks via ffmpeg (`ffmpeg-static` + `fluent-ffmpeg`, no system ffmpeg required), (2) transcribes each chunk with Whisper at `{baseUrl}/v1/audio/transcriptions`, (3) aligns Whisper segments to SRT segments by timecode overlap, (4) sends SRT + interleaved `[WHISPER: ...]` annotations to Claude for contextual comparison.

The client sends its Anthropic API key and optional base URL with every request. The server forwards them to the Anthropic SDK (`AnthropicClient`) and to Whisper (as `Authorization: Bearer`). No keys are stored server-side.

**`public/index.html`** — Single-file SPA (HTML + CSS + JS, no framework, no build). Three phases driven by a `showPhase(name)` function:
- `upload` — file drop zones for SRT + optional media, settings panel.
- `processing` — progress bar while the server call runs.
- `review` — diff view + media player.

Key client subsystems:
- **SRT parsing** (`parseSRT`) handles both indexed (`1\ntimecode\ntext`) and non-indexed (`timecode\ntext`) formats, BOM, and Windows line endings.
- **Word diff** (`wordDiff`) — LCS-based token-level diff; renders `<del>` / `<ins>` spans inside each segment card.
- **Media sync** — `timeupdate` listener maps `player.currentTime` to the current SRT segment and scrolls + highlights the matching card. Reverse: clicking a card seeks the player.
- **Sticky video layout** — video container is `position: sticky`; its `top` is calculated in JS from measured header heights, and a `ResizeObserver` on the container keeps the diff-column headers pinned just below it.
- **Session persistence** — segments stored in `localStorage`; media file binary stored in `IndexedDB` (`transcript-corrector` db, `files` store). Restored on page load if a completed session exists.
- **Theme** — `body.theme-light` class toggles a full set of CSS variable overrides; preference persisted in `localStorage`.

## Key conventions

- The API base URL is stored without the `/v1/messages` suffix (the server strips it if present). Whisper is called at `{baseUrl}/v1/audio/transcriptions`.
- SRT chunks sent to Claude are wrapped in `<srt>...</srt>` tags; Claude's response is extracted with the same regex. Audio mode uses `<srt_with_reference>` tags and `[WHISPER: ...]` annotation lines (stripped from the parsed output).
- `express.json` limit is `500mb` to accommodate base64-encoded media files.
- `ffmpeg-static` bundles the ffmpeg binary via npm — no system dependency. Temp files are written to `os.tmpdir()` and cleaned up in a `finally` block.
