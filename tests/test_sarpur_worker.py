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

import ruvsarpur  # noqa: E402
import sarpur_worker  # noqa: E402


EPISODE = {
    "pid": "p1", "sid": "10", "title": "Show (1 af 2)", "series_title": "Show",
    "showtime": "2024-01-02 20:00:00", "ep_num": "1", "ep_total": "2", "season_num": 1,
    "multiple_episodes": True, "is_movie": False, "is_docu": False, "is_sport": False,
    "original-title": "Original Show", "imdb": {"id": "tt123", "year": 2020},
}
MOVIE = {
    "pid": "p2", "sid": "11", "title": "Movie", "series_title": "Movie",
    "showtime": "2023-05-06 21:00:00", "is_movie": True, "imdb": None,
}


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self._cwd = os.getcwd()
        os.chdir(self._tmp.name)
        self.addCleanup(os.chdir, self._cwd)
        schedule = {"date": "2024-01-02", "p1": EPISODE, "p2": MOVIE}
        Path("tvschedule.json").write_text(json.dumps(schedule), encoding="utf-8")

    def run_worker(self, *argv):
        out = io.StringIO()
        err = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = sarpur_worker.main(list(argv) + ["--portable"])
        return code, out.getvalue(), err.getvalue()

    def parse_lines(self, text):
        return [json.loads(line) for line in text.splitlines()]

    def test_name_matches_create_local_file_name(self):
        for mode, plex in (("web", False), ("plex", True)):
            for item in (EPISODE, MOVIE):
                code, out, _ = self.run_worker("name", item["pid"], "--mode", mode)
                self.assertEqual(code, 0)
                (line,) = self.parse_lines(out)
                self.assertEqual(line["path"], ruvsarpur.createLocalFileName(item, False, plex, ""))
                self.assertEqual(line["title"], ruvsarpur.createShowTitle(item, False, plex))

    def test_name_options_and_output_is_json_only(self):
        code, out, _ = self.run_worker("name", "p1", "--mode", "plex", "--originaltitle", "--suffix", " X")
        self.assertEqual(code, 0)
        (line,) = self.parse_lines(out)
        self.assertEqual(line["path"], ruvsarpur.createLocalFileName(EPISODE, True, True, " X"))

    def test_ruvsarpur_prints_are_kept_off_stdout(self):
        def noisy(*_args):
            print("noise from ruvsarpur")
            return {"date": mock.MagicMock(), "p1": EPISODE}
        with mock.patch.object(ruvsarpur, "getExistingTvSchedule", side_effect=noisy):
            code, out, err = self.run_worker("catalogue")
        self.assertEqual(code, 0)
        self.assertEqual(len(self.parse_lines(out)), 1)
        self.assertIn("noise from ruvsarpur", err)

    def test_catalogue_reads_temp_schedule(self):
        code, out, _ = self.run_worker("catalogue")
        self.assertEqual(code, 0)
        lines = self.parse_lines(out)
        self.assertEqual({line["pid"] for line in lines}, {"p1", "p2"})

    def test_catalogue_without_schedule_fails(self):
        os.remove("tvschedule.json")
        code, out, _ = self.run_worker("catalogue")
        self.assertNotEqual(code, 0)
        self.assertIn("error", self.parse_lines(out)[-1])

    def test_unknown_command_exits_non_zero(self):
        code, out, _ = self.run_worker("bogus")
        self.assertNotEqual(code, 0)
        self.assertIn("error", self.parse_lines(out)[-1])

    def test_unknown_pid_exits_non_zero(self):
        code, out, _ = self.run_worker("name", "nope", "--mode", "web")
        self.assertNotEqual(code, 0)
        self.assertIn("error", self.parse_lines(out)[-1])

    def test_imdb_from_schedule_and_missing(self):
        code, out, _ = self.run_worker("imdb", "10")
        self.assertEqual(self.parse_lines(out), [{"sid": "10", "imdb": EPISODE["imdb"]}])
        code, out, _ = self.run_worker("imdb", "11")
        self.assertEqual(self.parse_lines(out), [{"sid": "11", "imdb": None}])

    def test_now_freezes_today(self):
        seen = {}

        def fake(*_args):
            seen["today"] = ruvsarpur.datetime.date.today()
            seen["now"] = ruvsarpur.datetime.datetime.now()
            return {}
        with mock.patch.object(ruvsarpur, "getExistingTvSchedule", side_effect=fake):
            self.run_worker("catalogue", "--now", "2030-02-03T04:05:06")
        self.assertEqual(str(seen["today"]), "2030-02-03")
        self.assertEqual(seen["now"].isoformat(), "2030-02-03T04:05:06")
        self.assertNotEqual(ruvsarpur.datetime.date.today().year, 2030)

    def test_resolve_uses_playlist_finder_without_network(self):
        item = dict(EPISODE, file=ruvsarpur.RUV_URL + "/x/1/1.m3u8", subtitles=[])
        schedule = {"date": "2024-01-02", "p1": item}
        Path("tvschedule.json").write_text(json.dumps(schedule), encoding="utf-8")
        found = {"url": "https://u/v.m3u8", "audio_url": "https://u/a.m3u8", "fragments": 3, "quality": "Normal"}
        with mock.patch.object(ruvsarpur, "find_m3u8_playlist_url", return_value=found) as finder:
            code, out, _ = self.run_worker("resolve", "p1", "--quality", "Normal")
        self.assertEqual(code, 0)
        (line,) = self.parse_lines(out)
        self.assertEqual(line, {"pid": "p1", "playlist_url": "https://u/v.m3u8", "audio_url": "https://u/a.m3u8",
                                "quality": "Normal", "fragments": 3, "subtitles": []})
        self.assertEqual(finder.call_args[0][0]["vod_url"], ruvsarpur.RUV_URL + "/x/1")


if __name__ == "__main__":
    unittest.main()
