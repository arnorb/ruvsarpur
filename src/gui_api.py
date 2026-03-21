# src/gui_api.py
from __future__ import annotations

import datetime
import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from mimetypes import guess_type
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import urlopen

import ruvsarpur


@dataclass
class ApiConfig:
    host: str = "127.0.0.1"
    port: int = 8000
    portable: bool = False


RE_TRAILING_PARENTHESIS = re.compile(r"\s*\([^)]*\)\s*$")


def _default_settings() -> dict:
    return {
        "watchlistSids": [],
        "autoEnabled": False,
        "autoIntervalMinutes": 60,
        "outputDir": str((Path.cwd() / "downloads").resolve()),
        "plexBaseUrl": "",
        "plexToken": "",
        "plexLibrarySectionId": "",
        "plexLibraryPath": "",
    }


def _default_status() -> dict:
    return {
        "isRunning": False,
        "lastRunAt": None,
        "lastRunStatus": None,
        "lastRunMessage": None,
    }


def _normalize_series_title(raw_title: str) -> str:
    title = str(raw_title or "").strip()
    # Remove trailing parenthesis groups such as "(1 af 6)" from series labels.
    while title:
        updated = RE_TRAILING_PARENTHESIS.sub("", title).strip()
        if updated == title:
            break
        title = updated
    return title


def _json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
    handler.end_headers()
    handler.wfile.write(body)


class ApiRuntime:
    def __init__(self, config: ApiConfig):
        self.config = config
        self._lock = threading.Lock()
        self.settings_file = Path(
            ruvsarpur.createFullConfigFileName(config.portable, "gui-settings.json")
        )
        self.settings = self._load_settings()
        self.status = _default_status()
        self.web_download_dir = (Path.cwd() / "downloads" / "_web_tmp").resolve()
        self.web_download_dir.mkdir(parents=True, exist_ok=True)
        self.web_download_tokens: dict[str, Path] = {}
        self._last_auto_run_unix = 0.0
        self._scheduler_thread = threading.Thread(target=self._scheduler_loop, daemon=True)
        self._scheduler_thread.start()

    def register_web_download_file(self, file_path: Path) -> str:
        token = uuid.uuid4().hex
        with self._lock:
            self.web_download_tokens[token] = file_path
        return token

    def pop_web_download_file(self, token: str) -> Path | None:
        with self._lock:
            return self.web_download_tokens.pop(token, None)

    def _load_settings(self) -> dict:
        defaults = _default_settings()
        existing = ruvsarpur.getExistingJsonFile(str(self.settings_file))
        if not isinstance(existing, dict):
            return defaults
        merged = {**defaults, **existing}
        merged["watchlistSids"] = [str(sid) for sid in merged.get("watchlistSids", []) if sid]
        merged["autoIntervalMinutes"] = max(5, int(merged.get("autoIntervalMinutes", 60)))
        return merged

    def _save_settings(self) -> None:
        self.settings_file.parent.mkdir(parents=True, exist_ok=True)
        with self.settings_file.open("w", encoding="utf-8") as out_file:
            out_file.write(json.dumps(self.settings, ensure_ascii=False, sort_keys=True, indent=2))

    def get_settings(self) -> dict:
        with self._lock:
            return dict(self.settings)

    def update_settings(self, patch: dict) -> dict:
        with self._lock:
            for key in _default_settings().keys():
                if key in patch:
                    self.settings[key] = patch[key]
            self.settings["watchlistSids"] = [
                str(sid) for sid in self.settings.get("watchlistSids", []) if sid
            ]
            self.settings["autoIntervalMinutes"] = max(
                5, int(self.settings.get("autoIntervalMinutes", 60))
            )
            self._save_settings()
            return dict(self.settings)

    def get_status(self) -> dict:
        with self._lock:
            return dict(self.status)

    def _set_status(self, **kwargs) -> None:
        with self._lock:
            self.status.update(kwargs)

    def add_watchlist_sid(self, sid: str) -> list[str]:
        sid = str(sid).strip()
        if not sid:
            return self.get_settings()["watchlistSids"]
        with self._lock:
            watchlist = self.settings.get("watchlistSids", [])
            if sid not in watchlist:
                watchlist.append(sid)
            self.settings["watchlistSids"] = watchlist
            self._save_settings()
            return list(watchlist)

    def remove_watchlist_sid(self, sid: str) -> list[str]:
        sid = str(sid).strip()
        with self._lock:
            watchlist = [item for item in self.settings.get("watchlistSids", []) if item != sid]
            self.settings["watchlistSids"] = watchlist
            self._save_settings()
            return list(watchlist)

    def run_auto_download_now(self) -> bool:
        with self._lock:
            if self.status.get("isRunning"):
                return False
            self.status["isRunning"] = True
        threading.Thread(target=self._run_auto_download_job, daemon=True).start()
        return True

    def _scheduler_loop(self) -> None:
        while True:
            time.sleep(10)
            with self._lock:
                auto_enabled = bool(self.settings.get("autoEnabled"))
                interval_minutes = max(5, int(self.settings.get("autoIntervalMinutes", 60)))
                is_running = bool(self.status.get("isRunning"))
            if not auto_enabled or is_running:
                continue
            elapsed_seconds = time.time() - self._last_auto_run_unix
            if elapsed_seconds >= interval_minutes * 60:
                self.run_auto_download_now()

    def _run_plex_refresh(self) -> tuple[bool, str]:
        with self._lock:
            base_url = str(self.settings.get("plexBaseUrl", "")).strip().rstrip("/")
            token = str(self.settings.get("plexToken", "")).strip()
            section_id = str(self.settings.get("plexLibrarySectionId", "")).strip()
            section_path = str(self.settings.get("plexLibraryPath", "")).strip()

        if not base_url or not token or not section_id:
            return False, "Plex refresh skipped (missing Plex settings)"

        refresh_url = f"{base_url}/library/sections/{section_id}/refresh?X-Plex-Token={quote(token)}"
        if section_path:
            refresh_url += f"&path={quote(section_path)}"
        try:
            with urlopen(refresh_url, timeout=10) as response:
                if 200 <= response.status < 300:
                    return True, "Plex library refresh triggered"
                return False, f"Plex refresh failed (HTTP {response.status})"
        except Exception as ex:
            return False, f"Plex refresh failed: {ex}"

    def _run_auto_download_job(self) -> None:
        self._last_auto_run_unix = time.time()
        start_iso = datetime.datetime.utcnow().isoformat() + "Z"
        self._set_status(lastRunAt=start_iso, lastRunStatus="running", lastRunMessage="Auto run started")

        with self._lock:
            watchlist = list(self.settings.get("watchlistSids", []))
            output_dir = str(self.settings.get("outputDir", "")).strip() or str(
                (Path.cwd() / "downloads").resolve()
            )
            portable = self.config.portable

        if len(watchlist) == 0:
            self._set_status(isRunning=False, lastRunStatus="ok", lastRunMessage="No followed series to download")
            return

        os.makedirs(output_dir, exist_ok=True)
        script_path = Path(__file__).resolve().parent / "ruvsarpur.py"
        command = [
            sys.executable,
            str(script_path),
            "--sid",
            *watchlist,
            "--output",
            output_dir,
            "--refresh",
            "--incremental",
            "--checklocal",
            "--plex",
        ]
        if portable:
            command.append("--portable")

        proc = subprocess.run(command, capture_output=True, text=True)
        if proc.returncode != 0:
            self._set_status(
                isRunning=False,
                lastRunStatus="error",
                lastRunMessage=proc.stderr.strip() or proc.stdout.strip() or "Auto download failed",
            )
            return

        plex_ok, plex_message = self._run_plex_refresh()
        final_msg = "Auto download completed"
        if plex_message:
            final_msg = f"{final_msg}. {plex_message}"
        self._set_status(
            isRunning=False,
            lastRunStatus="ok" if plex_ok or "skipped" in plex_message.lower() else "warning",
            lastRunMessage=final_msg,
        )


def _load_schedule(refresh: bool, portable: bool) -> dict:
    today = datetime.date.today()
    tv_schedule_file_name = ruvsarpur.createFullConfigFileName(portable, ruvsarpur.TV_SCHEDULE_LOG_FILE)
    imdb_cache_file_name = ruvsarpur.createFullConfigFileName(portable, ruvsarpur.IMDB_CACHE_FILE)
    imdb_cache = ruvsarpur.getExistingJsonFile(imdb_cache_file_name) or {}

    schedule = ruvsarpur.getExistingTvSchedule(tv_schedule_file_name)
    if schedule is None or refresh:
        if schedule is None or schedule["date"].date() < today:
            schedule = {}
        schedule = ruvsarpur.getVodSchedule(schedule, len(schedule) > 0, imdb_cache, None)
        if len(schedule) > 1:
            ruvsarpur.saveCurrentTvSchedule(schedule, tv_schedule_file_name)
        if len(imdb_cache) > 0:
            ruvsarpur.saveImdbCache(imdb_cache, imdb_cache_file_name)
    return schedule


def _search_schedule(schedule: dict, query: str | None, watchlist_sids: list[str]) -> list[dict]:
    # Reuse the script's own matching implementation to keep CLI and API behavior aligned.
    args = SimpleNamespace(
        sid=None,
        pid=None,
        find=query if query and len(query.strip()) > 0 else None,
        originaltitle=False,
        new=False,
        includeenglishsubs=False,
    )
    items = ruvsarpur.searchForItemsInTvSchedule(args, schedule)
    items = sorted(items, key=lambda item: item.get("showtime", ""), reverse=True)
    results = []
    for item in items:
        show_title = ruvsarpur.createShowTitle(item, False)
        series_title = _normalize_series_title(item.get("series_title") or show_title)
        slug = str(item.get("slug", "")).strip()
        pid = str(item.get("pid", "")).strip()
        web_url = f"https://www.ruv.is/sjonvarp/spila/{slug}/{pid}" if slug and pid else "https://www.ruv.is/sjonvarp"
        content_type = (
            "movie_or_docu"
            if item.get("is_movie") or item.get("is_docu")
            else "sport"
            if item.get("is_sport")
            else "show"
        )
        results.append(
            {
                "pid": str(item.get("pid", "")),
                "sid": str(item.get("sid", "")),
                "title": show_title,
                "seriesTitle": series_title,
                "publishedAt": item.get("showtime"),
                "webUrl": web_url,
                # Prefer portrait-style artwork for poster card rendering.
                "posterUrl": item.get("portrait_image") or item.get("series_image") or item.get("episode_image"),
                "isFollowed": str(item.get("sid", "")) in watchlist_sids,
                "contentType": content_type,
            }
        )
    return results


def _run_download(pid: str, output_dir: str, portable: bool, mode: str) -> tuple[bool, str]:
    script_path = Path(__file__).resolve().parent / "ruvsarpur.py"
    command = [
        sys.executable,
        str(script_path),
        "--pid",
        str(pid),
        "--output",
        output_dir,
    ]
    if mode == "library":
        command.append("--checklocal")
        command.append("--plex")
    else:
        # Web mode should always materialize a local file in the target folder.
        command.append("--force")
    if portable:
        command.append("--portable")
    proc = subprocess.run(command, capture_output=True, text=True)
    if proc.returncode != 0:
        return False, proc.stderr.strip() or proc.stdout.strip() or "Download failed"
    if mode == "library":
        return True, "Library download completed"
    return True, "Web download completed"


def _find_latest_downloaded_video(output_dir: str, pid: str) -> Path | None:
    output_path = Path(output_dir)
    if not output_path.exists():
        return None
    video_extensions = {".mp4", ".mkv", ".webm", ".mov", ".m4v"}
    candidates: list[Path] = []
    for candidate in output_path.rglob("*"):
        if not candidate.is_file():
            continue
        if candidate.suffix.lower() not in video_extensions:
            continue
        if pid and pid in candidate.name:
            candidates.append(candidate)
    if len(candidates) == 0:
        for candidate in output_path.rglob("*"):
            if candidate.is_file() and candidate.suffix.lower() in video_extensions:
                candidates.append(candidate)
    if len(candidates) == 0:
        return None
    return max(candidates, key=lambda item: item.stat().st_mtime)


def create_handler(config: ApiConfig, runtime: ApiRuntime):
    class Handler(BaseHTTPRequestHandler):
        def _read_json_body(self) -> tuple[dict | None, str | None]:
            try:
                content_length = int(self.headers.get("Content-Length", "0"))
                raw_body = self.rfile.read(content_length) if content_length > 0 else b"{}"
                return json.loads(raw_body.decode("utf-8")), None
            except Exception:
                return None, "Invalid JSON body"

        def do_OPTIONS(self) -> None:  # noqa: N802
            _json_response(self, 200, {"ok": True})

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path == "/api/health":
                _json_response(self, 200, {"ok": True})
                return

            if parsed.path == "/api/shows":
                query_params = parse_qs(parsed.query)
                query = query_params.get("query", [""])[0]
                refresh = query_params.get("refresh", ["0"])[0] in {"1", "true", "yes"}
                try:
                    schedule = _load_schedule(refresh=refresh, portable=config.portable)
                    settings = runtime.get_settings()
                    shows = _search_schedule(schedule, query, settings.get("watchlistSids", []))
                    _json_response(self, 200, {"shows": shows})
                except Exception as ex:
                    _json_response(self, 500, {"error": str(ex)})
                return

            if parsed.path == "/api/settings":
                _json_response(self, 200, {"settings": runtime.get_settings(), "status": runtime.get_status()})
                return

            if parsed.path == "/api/watchlist":
                _json_response(self, 200, {"watchlistSids": runtime.get_settings().get("watchlistSids", [])})
                return

            if parsed.path == "/api/auto/status":
                _json_response(self, 200, {"status": runtime.get_status()})
                return

            if parsed.path == "/api/download-file":
                query_params = parse_qs(parsed.query)
                token = str(query_params.get("token", [""])[0]).strip()
                if not token:
                    _json_response(self, 400, {"error": "Query parameter 'token' is required"})
                    return
                file_path = runtime.pop_web_download_file(token)
                if file_path is None or not file_path.exists() or not file_path.is_file():
                    _json_response(self, 404, {"error": "Download token expired or file not found"})
                    return
                mime_type = guess_type(file_path.name)[0] or "application/octet-stream"
                try:
                    file_bytes = file_path.read_bytes()
                except Exception as ex:
                    _json_response(self, 500, {"error": f"Could not read download file: {ex}"})
                    return
                self.send_response(200)
                self.send_header("Content-Type", mime_type)
                self.send_header("Content-Length", str(len(file_bytes)))
                self.send_header("Content-Disposition", f'attachment; filename="{file_path.name}"')
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
                self.end_headers()
                self.wfile.write(file_bytes)
                return

            _json_response(self, 404, {"error": "Not found"})

        def do_POST(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)

            if parsed.path == "/api/settings":
                body, error = self._read_json_body()
                if error:
                    _json_response(self, 400, {"error": error})
                    return
                updated = runtime.update_settings(body or {})
                _json_response(self, 200, {"ok": True, "settings": updated})
                return

            if parsed.path == "/api/watchlist":
                body, error = self._read_json_body()
                if error:
                    _json_response(self, 400, {"error": error})
                    return
                sid = str((body or {}).get("sid", "")).strip()
                if not sid:
                    _json_response(self, 400, {"error": "Field 'sid' is required"})
                    return
                watchlist = runtime.add_watchlist_sid(sid)
                _json_response(self, 200, {"ok": True, "watchlistSids": watchlist})
                return

            if parsed.path == "/api/auto/run-now":
                started = runtime.run_auto_download_now()
                if not started:
                    _json_response(self, 409, {"error": "Auto download is already running"})
                    return
                _json_response(self, 200, {"ok": True, "message": "Auto download started"})
                return

            if parsed.path != "/api/download":
                _json_response(self, 404, {"error": "Not found"})
                return

            body, error = self._read_json_body()
            if error:
                _json_response(self, 400, {"error": error})
                return

            pid = str((body or {}).get("pid", "")).strip()
            output_dir = str((body or {}).get("outputDir", "")).strip()
            mode = str((body or {}).get("mode", "library")).strip().lower()
            if not pid:
                _json_response(self, 400, {"error": "Field 'pid' is required"})
                return
            if mode not in {"web", "library"}:
                _json_response(self, 400, {"error": "Field 'mode' must be 'web' or 'library'"})
                return

            if not output_dir:
                if mode == "web":
                    # Web mode uses a temporary server-side directory and then streams the file to browser.
                    output_dir = str(runtime.web_download_dir)
                else:
                    output_dir = runtime.get_settings().get("outputDir") or str((Path.cwd() / "downloads").resolve())

            os.makedirs(output_dir, exist_ok=True)
            ok, message = _run_download(
                pid=pid,
                output_dir=output_dir,
                portable=config.portable,
                mode=mode,
            )
            if not ok:
                _json_response(self, 500, {"error": message})
                return

            payload = {"ok": True, "message": message, "outputDir": output_dir, "pid": pid, "mode": mode}
            if mode == "web":
                downloaded_file = _find_latest_downloaded_video(output_dir=output_dir, pid=pid)
                if downloaded_file is None:
                    _json_response(self, 500, {"error": "Web download completed but no local video file was found"})
                    return
                token = runtime.register_web_download_file(downloaded_file)
                payload["downloadUrl"] = f"/api/download-file?token={token}"
                payload["fileName"] = downloaded_file.name
            _json_response(self, 200, payload)

        def do_DELETE(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path != "/api/watchlist":
                _json_response(self, 404, {"error": "Not found"})
                return
            query_params = parse_qs(parsed.query)
            sid = str(query_params.get("sid", [""])[0]).strip()
            if not sid:
                _json_response(self, 400, {"error": "Query parameter 'sid' is required"})
                return
            watchlist = runtime.remove_watchlist_sid(sid)
            _json_response(self, 200, {"ok": True, "watchlistSids": watchlist})

        def log_message(self, format: str, *args) -> None:  # noqa: A003
            # Keep logs minimal when running alongside the frontend dev server.
            return

    return Handler


def main() -> None:
    config = ApiConfig(
        host=os.getenv("RUVSARPUR_GUI_HOST", "127.0.0.1"),
        port=int(os.getenv("RUVSARPUR_GUI_PORT", "8000")),
        portable=os.getenv("RUVSARPUR_GUI_PORTABLE", "0") in {"1", "true", "yes"},
    )
    runtime = ApiRuntime(config)
    server = ThreadingHTTPServer((config.host, config.port), create_handler(config, runtime))
    print(f"GUI API listening on http://{config.host}:{config.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
