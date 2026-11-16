# Switchboard.app (SwiftUI front end)

A menu bar app plus a System Settings–style window. It holds no logic of its own: it calls the bundled
`switchboard` helper and reads the files the service writes. Product notes: `PRODUCT.md`.

## Build

```bash
swift build -c release   # → .build/release/Switchboard (arm64, macOS 14+)
```

The executable product is **`Switchboard`**; the bundle puts it at `Contents/MacOS/Switchboard`
(`CFBundleExecutable = Switchboard`, `LSUIElement = YES`).

## What it expects inside the bundle

| Path | Used for |
|---|---|
| `Contents/Helpers/switchboard` | `app-setup` (every launch), `set-channel`, `doctor`, the OpenMausBot setup block |
| `Contents/Helpers/allman` | `allman login --store ~/.allman` (LinkedIn sign-in) |

The app runs `switchboard daemon` as its own child (`ServiceRunner.swift`, copied from `scripts/app/`), so the
one Full Disk Access grant to Switchboard.app covers it. Launch: retire the old separate agent, `app-setup`,
start the service; first run turns on Open at Login (`SMAppService.mainApp`). After `set-channel` the service
restarts. Quitting the app (confirmed) stops the service.
It reads `~/Library/Application Support/Switchboard/{status.json,config.json}` (every 3 s while the window
is open, every 15 s otherwise). It makes no network calls and never shows message text.

## Development

`dev/run.sh <first-run|configured|error|stopped> [shot.png] [page] [channel:mode]` runs the debug build
against synthetic fixtures (`dev/make-fixtures.py`) with a stub helper (its `daemon` just sleeps), so it never
touches the real service. With a `shot.png` it captures the window (or the confirmation for
`channel:mode`) and quits.

Overrides: `SWITCHBOARD_BIN`, `SWITCHBOARD_ALLMAN`, `SWITCHBOARD_HOME`
(fixture root, same rule as the service), `SWITCHBOARD_ALLMAN_STORE`, `SWITCHBOARD_FDA=granted|missing`,
`SWITCHBOARD_OPEN_WINDOW`, `SWITCHBOARD_SNAPSHOT`, `SWITCHBOARD_PAGE`, `SWITCHBOARD_PENDING`.
