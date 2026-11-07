import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SRC_DIR = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_DIR))

import gui_api  # noqa: E402


class DummyRuntime:
    def get_poster_api_path(self, _poster_url):
        return None


class GuiApiTests(unittest.TestCase):
    def test_web_download_jobs_use_separate_temporary_directories(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            runtime = gui_api.ApiRuntime.__new__(gui_api.ApiRuntime)
            runtime.web_download_dir = Path(temporary_directory)
            runtime._download_condition = gui_api.threading.Condition(gui_api.threading.RLock())
            runtime.download_jobs = {}
            runtime.download_job_order = []

            first = runtime.enqueue_download("normal-pid", "Normal", temporary_directory, "web", "show", ["is"])
            second = runtime.enqueue_download("english-pid", "English", temporary_directory, "web", "show", [])

            first_dir = Path(runtime.download_jobs[first["id"]]["outputDir"])
            second_dir = Path(runtime.download_jobs[second["id"]]["outputDir"])
            self.assertNotEqual(first_dir, second_dir)
            self.assertEqual(first_dir.parent, Path(temporary_directory))
            self.assertEqual(second_dir.parent, Path(temporary_directory))
            self.assertTrue(first_dir.is_dir())
            self.assertTrue(second_dir.is_dir())

    def test_clear_finished_download_jobs_keeps_active_jobs(self):
        runtime = gui_api.ApiRuntime.__new__(gui_api.ApiRuntime)
        runtime._download_condition = gui_api.threading.Condition(gui_api.threading.RLock())
        runtime.download_job_order = ["completed", "active", "cancelled"]
        runtime.download_jobs = {
            "completed": {"status": "completed"},
            "active": {"status": "downloading"},
            "cancelled": {"status": "cancelled"},
        }

        cleared = runtime.clear_finished_download_jobs()

        self.assertEqual(cleared, 2)
        self.assertEqual(runtime.download_job_order, ["active"])
        self.assertEqual(list(runtime.download_jobs), ["active"])

    def test_retry_download_job_copies_original_options(self):
        runtime = gui_api.ApiRuntime.__new__(gui_api.ApiRuntime)
        runtime._lock = gui_api.threading.RLock()
        runtime.download_jobs = {
            "failed": {
                "status": "failed", "pid": "episode-1", "title": "Example",
                "outputDir": "downloads", "mode": "web", "contentType": "show",
                "subtitleLanguages": ["is", "en"],
            }
        }
        with mock.patch.object(runtime, "enqueue_download", return_value={"id": "retry"}) as enqueue:
            retried = runtime.retry_download_job("failed")
        self.assertEqual(retried, {"id": "retry"})
        enqueue.assert_called_once_with(
            pid="episode-1", title="Example", output_dir="downloads", mode="web",
            content_type="show", subtitle_languages=["is", "en"], client_id=None,
        )

    def test_search_exposes_categories_and_subtitle_choices(self):
        item = {
            "pid": "episode-1",
            "sid": "series-1",
            "series_title": "Example",
            "title": "Example",
            "showtime": "2026-07-20T20:00:00",
            "duration": "1477",
            "duration_friendly": "00:24",
            "episode": {
                "firstrun": "2026-07-19T20:00:00",
                "files": {"vodmp4": {"expires": "2026-08-15"}},
            },
            "categories": ["Menning", "Skemmtiefni"],
            "subtitles": [
                {"name": "is", "value": "https://example/is.vtt"},
                {"name": "en", "value": "https://example/en.vtt"},
            ],
            "english_subtitled": False,
        }
        with mock.patch.object(gui_api.ruvsarpur, "searchForItemsInTvSchedule", return_value=[item]) as search:
            results = gui_api._search_schedule({}, None, [], DummyRuntime())

        self.assertTrue(search.call_args.args[0].includeenglishsubs)
        self.assertEqual(results[0]["categories"], ["Menning", "Skemmtiefni"])
        self.assertEqual(results[0]["subtitleLanguages"], ["en", "is"])
        self.assertEqual(results[0]["durationSeconds"], 1477)
        self.assertEqual(results[0]["durationLabel"], "00:24")
        self.assertEqual(results[0]["firstAppearedAt"], "2026-07-19T20:00:00")
        self.assertEqual(results[0]["expiresAt"], "2026-08-15")

    def test_download_command_limits_subtitle_languages(self):
        completed = mock.Mock(returncode=0, stdout="", stderr="")
        with mock.patch.object(gui_api.subprocess, "run", return_value=completed) as run:
            ok, _message = gui_api._run_download(
                pid="episode-1",
                output_dir="downloads",
                portable=True,
                mode="web",
                subtitle_languages=["is", "en"],
            )

        self.assertTrue(ok)
        command = run.call_args.args[0]
        self.assertIn("--includeenglishsubs", command)
        self.assertEqual(command[command.index("--subtitlelanguages") + 1 :], ["is", "en"])

    def test_browser_download_includes_srt_sidecars_without_duplicate_vtt(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            video = directory / "Example [episode-1].mp4"
            video.write_bytes(b"video")
            (directory / "Example [episode-1].is.vtt").write_text("WEBVTT", encoding="utf-8")
            (directory / "Example [episode-1].is.srt").write_text("1", encoding="utf-8")
            (directory / "Example [episode-1].en.vtt").write_text("WEBVTT", encoding="utf-8")

            files = gui_api._find_download_files(temporary_directory, "episode-1")

        self.assertEqual(
            [file.name for file in files],
            ["Example [episode-1].mp4", "Example [episode-1].is.srt", "Example [episode-1].en.vtt"],
        )


def _schedule_item(pid: str = "bfcj7b") -> dict:
    return {
        "pid": pid,
        "sid": "35000",
        "title": "Hvolpasveitin (3 af 10)",
        "series_title": "Hvolpasveitin",
        "original-title": None,
        "showtime": "2026-11-01 08:00:00",
        "ep_num": 3,
        "ep_total": 10,
        "season_num": 1,
        "multiple_episodes": True,
        "is_movie": False,
        "is_docu": False,
        "is_sport": False,
        "file": "https://ruv-vod.akamaized.net/opid/5237646T0/5237646T0.m3u8",
        "subtitles": [],
    }


@contextlib.contextmanager
def _working_directory(path: str):
    previous = os.getcwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(previous)


def _run_cli(command: list[str]) -> list[dict]:
    """Run ruvsarpur.runMain with the GUI's command, network and ffmpeg mocked.

    Returns the RUVSARPUR_RESULT records it printed.
    """
    ruvsarpur = gui_api.ruvsarpur

    def fake_ffmpeg(_exec, _url, _fragments, local_filename, *_args, **_kwargs):
        # Like the real function, which always writes an .mp4.
        if not local_filename.endswith(".mp4"):
            local_filename += ".mp4"
        Path(local_filename).parent.mkdir(parents=True, exist_ok=True)
        Path(local_filename).write_bytes(b"video")
        return local_filename

    script_index = next(i for i, part in enumerate(command) if part.endswith("ruvsarpur.py"))
    output = io.StringIO()
    with mock.patch.object(sys, "argv", ["ruvsarpur.py", *command[script_index + 1 :]]), \
            mock.patch.dict(os.environ, {"RUVSARPUR_PROGRESS_JSON": "1"}), \
            mock.patch.object(ruvsarpur, "findffmpeg", return_value="ffmpeg"), \
            mock.patch.object(ruvsarpur, "find_m3u8_playlist_url", return_value={"url": "u", "fragments": 1}), \
            mock.patch.object(ruvsarpur, "download_m3u8_playlist_using_ffmpeg", side_effect=fake_ffmpeg), \
            mock.patch.object(ruvsarpur, "downloadTVShowPoster"), \
            mock.patch.object(ruvsarpur, "downloadMoviePoster"), \
            contextlib.redirect_stdout(output):
        ruvsarpur.runMain()
    return [
        json.loads(line.split(":", 1)[1])
        for line in output.getvalue().splitlines()
        if line.startswith("RUVSARPUR_RESULT:")
    ]


class LibraryAfterBrowserDownloadTests(unittest.TestCase):
    """Acceptance criterion 1 (plan S1)."""

    def test_browser_download_does_not_block_library_download(self):
        with tempfile.TemporaryDirectory() as data_dir, _working_directory(data_dir):
            ruvsarpur = gui_api.ruvsarpur
            schedule = {"date": "2026-11-07", "bfcj7b": _schedule_item()}
            Path("tvschedule.json").write_text(json.dumps(schedule), encoding="utf-8")
            web_dir = str(Path(data_dir) / "web")
            library_dir = str(Path(data_dir) / "library")

            web_results = _run_cli(gui_api._build_download_command("bfcj7b", web_dir, True, "web"))
            self.assertEqual([r["status"] for r in web_results], ["downloaded"])
            self.assertNotIn("bfcj7b", ruvsarpur.getPreviouslyRecordedShows("./prevrecorded.log"))

            library_results = _run_cli(gui_api._build_download_command("bfcj7b", library_dir, True, "library"))
            self.assertEqual([r["status"] for r in library_results], ["downloaded"])
            self.assertTrue(Path(library_results[0]["path"]).is_file())
            self.assertTrue(str(Path(library_results[0]["path"]).resolve()).startswith(str(Path(library_dir).resolve())))
            self.assertEqual(gui_api._library_job_outcome(library_results, []), "Download completed")
            self.assertIn("bfcj7b", ruvsarpur.getPreviouslyRecordedShows("./prevrecorded.log"))

    def test_library_download_ignores_recorded_log_but_respects_existing_file(self):
        with tempfile.TemporaryDirectory() as data_dir, _working_directory(data_dir):
            schedule = {"date": "2026-11-07", "bfcj7b": _schedule_item()}
            Path("tvschedule.json").write_text(json.dumps(schedule), encoding="utf-8")
            Path("prevrecorded.log").write_text("bfcj7b\n", encoding="utf-8")
            library_dir = str(Path(data_dir) / "library")
            command = gui_api._build_download_command("bfcj7b", library_dir, True, "library")

            first = _run_cli(command)
            self.assertEqual(first[0]["status"], "downloaded")
            second = _run_cli(command)
            self.assertEqual(second[0]["status"], "exists")
            self.assertEqual(gui_api._library_job_outcome(second, []), "Already in the library")


class LibraryJobOutcomeTests(unittest.TestCase):
    def test_no_result_fails(self):
        with self.assertRaisesRegex(RuntimeError, "Nothing found"):
            gui_api._library_job_outcome([], ["Nothing found to download for bfcj7b"])

    def test_recorded_without_file_fails_with_retry_hint(self):
        with self.assertRaisesRegex(RuntimeError, "Retry to download it again"):
            gui_api._library_job_outcome([{"status": "recorded", "path": "/nope/x.mp4"}], [])

    def test_downloaded_but_missing_file_fails(self):
        with self.assertRaisesRegex(RuntimeError, "no file is in the library"):
            gui_api._library_job_outcome([{"status": "downloaded", "path": "/nope/x.mp4"}], [])

    def test_ffmpeg_failure_fails(self):
        with self.assertRaisesRegex(RuntimeError, "ffmpeg"):
            gui_api._library_job_outcome([{"status": "failed", "message": "ffmpeg failed"}], [])

    def test_renamed_file_with_glob_characters_counts_as_present(self):
        with tempfile.TemporaryDirectory() as directory:
            expected = Path(directory) / "Show [abc] - s01e01.mp4"
            (Path(directory) / "Show [abc] - s01e01 my note.mp4").write_bytes(b"v")
            self.assertTrue(gui_api._library_file_exists(str(expected)))
            self.assertFalse(gui_api._library_file_exists(str(Path(directory) / "Other.mp4")))


class SettingsWatchlistTests(unittest.TestCase):
    """Acceptance criterion 2 (plan S1)."""

    def test_update_settings_never_changes_watchlist(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = gui_api.ApiRuntime.__new__(gui_api.ApiRuntime)
            runtime._lock = gui_api.threading.RLock()
            runtime.settings_file = Path(directory) / "gui-settings.json"
            runtime.settings = {**gui_api._default_settings(), "watchlistSids": ["a", "b"]}

            for body in ({"watchlistSids": []}, {"watchlistSids": ["x"], "autoEnabled": True}, {"watchlistSids": None}):
                updated = runtime.update_settings(body)
                self.assertEqual(updated["watchlistSids"], ["a", "b"])
            self.assertTrue(updated["autoEnabled"])
            saved = json.loads(runtime.settings_file.read_text(encoding="utf-8"))
            self.assertEqual(saved["watchlistSids"], ["a", "b"])


def _bare_runtime(web_dir: Path):
    runtime = gui_api.ApiRuntime.__new__(gui_api.ApiRuntime)
    runtime._lock = gui_api.threading.RLock()
    runtime._download_condition = gui_api.threading.Condition(runtime._lock)
    runtime.web_download_dir = web_dir
    runtime.web_download_tokens = {}
    runtime._last_web_download_sweep_unix = 0.0
    runtime.download_jobs = {}
    runtime.download_job_order = []
    runtime._active_download_process = None
    runtime.config = gui_api.ApiConfig(portable=True)
    return runtime


class BrowserDownloadRoutingTests(unittest.TestCase):
    """Acceptance criterion 3 (plan S1), server side."""

    def test_jobs_carry_their_client_id_and_links_are_reusable(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = _bare_runtime(Path(directory))
            first = runtime.enqueue_download("pid-a", "A", directory, "web", "show", None, client_id="browser-1")
            second = runtime.enqueue_download("pid-b", "B", directory, "web", "show", None, client_id="browser-2")
            self.assertEqual(first["clientId"], "browser-1")
            self.assertEqual(second["clientId"], "browser-2")

            video = Path(runtime.download_jobs[first["id"]]["outputDir"]) / "A [pid-a].mp4"
            video.write_bytes(b"video")
            token = runtime.register_web_download_file(video)
            self.assertEqual(runtime.get_web_download_file(token), video)
            self.assertEqual(runtime.get_web_download_file(token), video)

    def test_retry_keeps_client_id(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = _bare_runtime(Path(directory))
            job = runtime.enqueue_download("pid-a", "A", directory, "web", "show", None, client_id="browser-1")
            runtime.download_jobs[job["id"]]["status"] = "failed"
            retried = runtime.retry_download_job(job["id"])
            self.assertEqual(retried["clientId"], "browser-1")

    def test_sweep_removes_only_old_finished_folders(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = _bare_runtime(Path(directory))
            old_unix = gui_api.time.time() - gui_api.WEB_DOWNLOAD_RETENTION.total_seconds() - 60
            for name in ("old-done", "old-active", "fresh"):
                (Path(directory) / name).mkdir()
            os.utime(Path(directory) / "old-done", (old_unix, old_unix))
            os.utime(Path(directory) / "old-active", (old_unix, old_unix))
            runtime.download_jobs = {"old-active": {"status": "downloading"}}
            runtime.web_download_tokens = {"expired": (Path(directory) / "x", old_unix), "live": (Path(directory) / "y", gui_api.time.time() + 60)}

            removed = runtime.sweep_web_downloads()

            self.assertEqual(removed, 1)
            self.assertEqual(sorted(p.name for p in Path(directory).iterdir()), ["fresh", "old-active"])
            self.assertEqual(list(runtime.web_download_tokens), ["live"])
            with mock.patch.object(gui_api.time, "time", return_value=old_unix + 10**6):
                runtime._last_web_download_sweep_unix = old_unix + 10**6
                self.assertIsNone(runtime.get_web_download_file("live"))


class ExecuteLibraryJobTests(unittest.TestCase):
    def _run_job(self, stdout_lines: list[str], mode: str = "library") -> dict:
        with tempfile.TemporaryDirectory() as directory:
            runtime = _bare_runtime(Path(directory))
            job = runtime.enqueue_download("pid-a", "A", directory, mode, "show", None)
            internal = runtime.download_jobs[job["id"]]
            process = mock.Mock()
            process.stdout = io.StringIO("".join(line + "\n" for line in stdout_lines))
            process.wait.return_value = 0
            with mock.patch.object(gui_api.subprocess, "Popen", return_value=process):
                runtime._execute_download_job(internal)
            return dict(internal)

    def test_exit_zero_without_file_is_failed(self):
        job = self._run_job(["'A' already recorded (pid=pid-a)", 'RUVSARPUR_RESULT:{"pid": "pid-a", "status": "recorded", "path": "/nope/A.mp4"}'])
        self.assertEqual(job["status"], "failed")
        self.assertIn("Retry to download it again", job["message"])

    def test_exit_zero_with_no_result_is_failed(self):
        job = self._run_job(["Error: Could not retrieve episode download url"])
        self.assertEqual(job["status"], "failed")

    def test_web_command_does_not_record(self):
        web = gui_api._build_download_command("p", "out", True, "web")
        library = gui_api._build_download_command("p", "out", True, "library")
        self.assertIn("--norecord", web)
        self.assertNotIn("--norecord", library)
        self.assertIn("--ignorerecorded", library)
        self.assertIn("--checklocal", library)


if __name__ == "__main__":
    unittest.main()
