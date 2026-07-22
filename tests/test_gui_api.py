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
            content_type="show", subtitle_languages=["is", "en"],
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


if __name__ == "__main__":
    unittest.main()
