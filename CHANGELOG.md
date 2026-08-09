# Changelog

All notable changes to **ClipFlow** are documented here. The project follows [Keep a Changelog](https://keepachangelog.com/) and [Semantic Versioning](https://semver.org/).

## [1.1.2] - 2026-08-09

### Added

- **Per-game capture profiles** — make a few generic presets (e.g. *Default*, *Competitivo* with a short buffer, *Cine* with HEVC + long buffer) and map foreground games to them. The buffer window applies live the moment a profile is applied; fps, bitrate and codec apply on the next engine start.
- **Auto-switch by foreground game** — with the toggle on, ClipFlow watches which window has focus and applies the mapped profile automatically (2 s poll, anti-flap cooldown). Unmapped games and the desktop fall back to the *Default* profile. Focus detection is a single cheap Win32 query (`GetForegroundWindow` + process image name), polled off the main thread.
- **Game mapping editor** — Settings → CAPTURE PROFILES: add/rename/delete profiles, and map any executable (e.g. `cs2.exe`) to a profile. The deck shows the current **GAME · PROFILE** chip at a glance.

## [1.1.1] - 2026-08-09

### Added

- **Session counter** in the Instant Replay panel: clips + bytes saved during the current run.
- Release pipeline now ships the **portable exe** on every release (`ClipFlow_vX.Y.Z_Portable.exe`).

### Fixed

- CI release creation permission (`contents: write` at job level) so the pipeline can publish releases automatically.

## [1.1.0] - 2026-08-09

### Added

- **Automatic updates via GitHub Releases** — signed installers (`.sig` + `latest.json`), checked on demand from Settings → About & Updates or silently at launch, with a one-click download & install + restart flow. Still no background updater service.
- **Custom hotkeys** — click the hotkey badge in Settings and press any new combination. Both the *save* (default `Alt+C`) and *arm/disarm* (default `Alt+Shift+C`) shortcuts rebind live and persist across restarts. Combos without a modifier are rejected (Windows reserves bare keys for typing).
- **HEVC (H.265) codec** — new toggle in Settings. Roughly halves file size while keeping hardware encoding (NVENC/AMF/QSV); applies on engine restart.
- **Open in external player** — new `▶` button on gallery cards and in the trimmer to play a clip in your default media player.
- **Rename clips** — inline rename in the trimmer (the header filename becomes editable).
- **PNG snapshots** — `◉ SNAPSHOT PNG` in the trimmer captures the current frame (hardware decode) into the ClipFlow output folder.
- **Gallery sort & filters** — sort by newest/oldest/largest/smallest/longest/shortest, an `♪ AUDIO` filter, and a `▦ COMPACT` grid view.
- **Clear library** — `✕ CLEAR` removes every clip with an explicit confirmation dialog.
- **Save confirmation sound** — the `playSaveSound` setting now actually works: a short locally-generated shutter blip on every flush.
- **Always-on-top** — pin the control deck above full-screen games from Settings.
- **Flush statistics** — the Instant Replay panel tracks last / average / best flush latency for the session.
- **First-run onboarding** — a dismissible overlay teaches the two hotkeys and the output folder on first launch.
- **Check for updates** — manual `RELEASES ↗` button in Settings opens the GitHub Releases page. Still zero background updater, zero telemetry.

### Fixed

- Hotkey validation at startup prevents a corrupt `settings.json` from registering dangerous bare-key shortcuts.
- `Settings` deserialization is now forward-compatible (`#[serde(default)]` on new fields), so existing `settings.json` files survive the upgrade.

## [1.0.0] - 2026-07-20

### Added

- Sub-50 ms instant replay flush (`Alt+C`) from a GPU-encoded rolling ring buffer.
- DXGI Desktop Duplication + Direct3D 11 capture with hardware H.264 MFT encoding (NVENC / AMF / QSV).
- WASAPI system audio loopback + microphone mixing, AAC-LC 48 kHz on a unified QPC clock.
- Key-frame stream-copy trimmer (lossless, no re-encode).
- Tray icon with Capture / Show / Folder / Quit menu.
- Gallery with hover-preview, copy-to-clipboard (CF_HDROP), reveal-in-Explorer and delete.
- Single portable binary, no account, no telemetry, no background updater.
