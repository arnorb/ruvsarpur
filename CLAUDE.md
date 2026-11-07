# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A downloader for the Icelandic RÚV Sarpur (VOD) service, in two layers:

- **`src/ruvsarpur.py`**: the original standalone CLI (list, search and download shows by `--sid`/`--pid`/`--find`). It still works on its own. See README.md for its full flag set.
- **Web GUI** (added in this fork): `src/gui_api.py` (a Python backend that uses only the stdlib HTTP server) plus `frontend/` (React 18, Vite 5, Tailwind 4 and shadcn-style UI components). They are deployed together with Docker Compose, for example on TrueNAS.

## Commands

Python (3.9+; the Docker image uses 3.11). `ffmpeg` must be on PATH, in a `bin/` folder next to the script, or passed with `--ffmpeg`.

```bash
pip install -r src/requirements.txt
python src/ruvsarpur.py --list --find "Hvolpa"        # CLI
python src/gui_api.py                                  # API on 127.0.0.1:8000
python -m unittest discover -s tests                   # all tests
python -m unittest tests.test_gui_api                  # one module
python -m unittest tests.test_gui_api.GuiApiTests.test_web_download_jobs_use_separate_temporary_directories
```

The tests import from `src/` by adding it to `sys.path`. Run them from the repo root. They need the requirements installed, because `ruvsarpur` imports `colorama` and the other dependencies at module load.

Frontend (in `frontend/`): `npm install`, `npm run dev`, `npm run build`. There is no lint or test script. `npm run build` runs plain `vite build` with no type-check step; run `npx tsc --noEmit` to type-check. In dev, the UI calls `http://127.0.0.1:8000` unless `VITE_API_BASE_URL` is set. The Docker build sets it to `""` so requests stay same-origin.

Full stack: `docker compose up -d --build`. The UI is served on `:8080`. Nginx proxies `/api/*` to the `ruvsarpur-api` container, and everything persistent lives in `./data` (mounted at `/data`). CI (`.github/workflows/docker-image.yml`) only builds and pushes the two images to GHCR. It runs no tests.

## Architecture

**`gui_api.py` uses `ruvsarpur.py` in these ways:**
1. **Imported as a module** for catalogue work: `_load_schedule` calls `getVodSchedule`, `getExistingTvSchedule`, `createFullConfigFileName` and other functions directly, and searching and filtering happen in-process.
2. **Run as a subprocess** for downloads: `_build_download_command` runs `python ruvsarpur.py --pid … --includeenglishsubs --output …`. Library mode adds `--checklocal --plex --ignorerecorded`, and web mode adds `--force --norecord`, so browser downloads never enter `prevrecorded.log`. The child is started with `RUVSARPUR_PROGRESS_JSON=1`, which makes `printProgress` emit `RUVSARPUR_PROGRESS:{json}` lines and `emitResult` emit one `RUVSARPUR_RESULT:{json}` line per episode (`downloaded`, `exists`, `recorded` or `failed`). `ApiRuntime` parses the progress lines for job progress, and a library job counts as completed only when its result points to a file that exists. ffmpeg writes to `<name>.mp4.part`, which is renamed only on success, so an interrupted download never looks finished to `--checklocal`.
3. **`ruvsarpur.py --json <command>`** is the JSON-lines worker for the planned Rust port (`src/sarpur_worker.py`; see `.omc/plans/sarpur-rewrite.md` §3.1).

So when you change a CLI flag or the progress output format, update the API's command builder or its parser to match. When you change a schedule or naming function, the API changes with it.

**`ApiRuntime`** (in `gui_api.py`) holds all server state behind a single `threading.Lock`/`Condition`:
- persisted GUI settings (`gui-settings.json`: watchlist SIDs, auto-download interval, library root plus the shows/movies/sports subfolders, Plex fields)
- a single-worker download job queue (`download_jobs` + `download_job_order`), with retry, delete and clear
- a background scheduler thread that auto-downloads watchlist series in library mode
- schedule refresh status, a poster proxy/cache that only allows the hosts in `POSTER_ALLOWED_HOSTS`, and tokens for `/api/download-file` that stay valid for 24 hours (browser jobs carry a `clientId` so each browser saves only its own files; `_web_tmp` is swept after 24 hours)

Routing is a hand-written `if parsed.path == …` chain in `do_GET`/`do_POST`/`do_DELETE` inside `create_handler`.

**Download modes:** "web" downloads go to `downloads/_web_tmp/<job>` and the browser fetches them through tokenised `/api/download-file` URLs. "library" downloads go to the category folder chosen by `_resolve_library_output_dir` and get Plex naming.

**Config/data location:** `createFullConfigFileName(portable, name)` resolves to `~/.ruvsarpur/` by default, or to the CWD when portable mode is on (`--portable`, or `RUVSARPUR_GUI_PORTABLE=1`). Docker uses portable mode with `WORKDIR /data`, which is how `tvschedule.json`, `imdb-cache.json`, `prevrecorded.log`, the poster cache and the settings all end up in `./data`. The API itself is configured through `RUVSARPUR_GUI_HOST`/`_PORT`/`_PORTABLE`.

**RÚV data sources** (all in `ruvsarpur.py`): `api.ruv.is/api/programs/...` for the catalogue and per-series episodes, `www.ruv.is/gql/` for GraphQL lookups, and HLS playlists on `ruv-vod.akamaized.net`. Quality variants are found by parsing the master m3u8 (`_playlist_quality_variants`), and a separate audio stream is picked from it (`_playlist_default_audio_url`). ffmpeg then muxes the streams into MP4 with metadata. Episode file names come from `createShowTitle`/`createLocalFileName`, which use the stable season/episode numbers rather than RÚV's "(N af M)" title suffix.

**Frontend:** nearly all of the UI is a single large `frontend/src/App.tsx`. `components/ui/` holds the small shadcn-style primitives, and `@` is aliased to `frontend/src`.

## Repo quirks

- `frontend/node_modules/` and `data/tvschedule.json` are committed to git. Don't stage changes to them by accident.
- The code style in `ruvsarpur.py` is old upstream style (camelCase, 2-space indents). `gui_api.py` is modern typed Python with 4-space indents. Follow the style of the file you are editing.
- `docs/` is the old GitHub Pages site for the upstream project (sverrirs/ruvsarpur), not developer documentation.
- `notes/ui-review-2026-11-07.md` reviews the Download, Library and Follow flows. The HIGH items and the temp-file sweep were fixed in S1 (checked off there); the MEDIUM and LOW items are still open. Check it before changing those flows.
