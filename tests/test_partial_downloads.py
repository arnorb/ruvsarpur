import os
import signal
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path


SRC_DIR = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_DIR))

import ruvsarpur  # noqa: E402


FAKE_FFMPEG = textwrap.dedent(
    """\
    #!{python}
    import sys, time
    output = sys.argv[-1]
    with open(output, "wb") as f:
        f.write(b"partial video")
    mode = {mode!r}
    if mode == "hang":
        time.sleep(60)
    sys.exit(0 if mode == "ok" else 1)
    """
)


def _fake_ffmpeg(directory: Path, mode: str) -> str:
    path = directory / f"ffmpeg-{mode}"
    path.write_text(FAKE_FFMPEG.format(python=sys.executable, mode=mode), encoding="utf-8")
    path.chmod(0o755)
    return str(path)


def _download(ffmpeg: str, local_filename: str):
    return ruvsarpur.download_m3u8_playlist_using_ffmpeg(
        ffmpeg, "https://example/playlist.m3u8", 1, local_filename, "Test",
        False, "HD1080", True, {},
    )


class PartialDownloadTests(unittest.TestCase):
    def test_successful_download_is_renamed_from_part_file(self):
        with tempfile.TemporaryDirectory() as directory:
            target = str(Path(directory) / "Show - s01e01.mp4")
            result = _download(_fake_ffmpeg(Path(directory), "ok"), target)
            self.assertEqual(result, target)
            self.assertTrue(Path(target).is_file())
            self.assertFalse(Path(target + ".part").exists())

    def test_failed_download_leaves_no_file_that_checklocal_would_accept(self):
        with tempfile.TemporaryDirectory() as directory:
            target = str(Path(directory) / "Show - s01e01.mp4")
            result = _download(_fake_ffmpeg(Path(directory), "fail"), target)
            self.assertIsNone(result)
            self.assertEqual(list(Path(directory).glob("Show*")), [])
            self.assertTrue(ruvsarpur.isLocalFileNameUnique(target))

    @unittest.skipIf(os.name == "nt", "the GUI stops downloads with taskkill on Windows")
    def test_stopped_download_removes_part_file(self):
        with tempfile.TemporaryDirectory() as directory:
            target = str(Path(directory) / "Show - s01e01.mp4")
            ffmpeg = _fake_ffmpeg(Path(directory), "hang")
            script = textwrap.dedent(
                f"""\
                import signal, sys
                sys.path.insert(0, {str(SRC_DIR)!r})
                import ruvsarpur
                signal.signal(signal.SIGTERM, ruvsarpur.raiseKeyboardInterruptOnSigterm)
                ruvsarpur.download_m3u8_playlist_using_ffmpeg(
                    {ffmpeg!r}, "u", 1, {target!r}, "Test", False, "HD1080", True, {{}})
                """
            )
            # Same as the GUI: its own process group, stopped with SIGTERM to the group.
            process = subprocess.Popen(
                [sys.executable, "-c", script], start_new_session=True,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            deadline = time.time() + 10
            while not Path(target + ".part").exists() and time.time() < deadline:
                time.sleep(0.05)
            self.assertTrue(Path(target + ".part").exists(), "fake ffmpeg never started")
            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
            process.wait(timeout=30)

            self.assertEqual(list(Path(directory).glob("Show*")), [])


if __name__ == "__main__":
    unittest.main()
