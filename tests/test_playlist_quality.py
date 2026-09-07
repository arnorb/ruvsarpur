import sys
import unittest
from pathlib import Path


SRC_DIR = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_DIR))

import ruvsarpur  # noqa: E402


class PlaylistQualityTests(unittest.TestCase):
    def test_current_ruv_variant_paths_are_discovered_from_master_playlist(self):
        master = """#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=7207916,RESOLUTION=1920x1080
1080p/stream.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4275116,RESOLUTION=1280x720
720p/stream.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1958956,RESOLUTION=960x540
540p/stream.m3u8
"""

        variants = ruvsarpur._playlist_quality_variants(
            master,
            "https://ruv-vod.akamaized.net/opid/example/example.m3u8",
        )

        self.assertEqual(variants["HD1080"]["url"], "https://ruv-vod.akamaized.net/opid/example/1080p/stream.m3u8")
        self.assertEqual(variants["HD720"]["url"], "https://ruv-vod.akamaized.net/opid/example/720p/stream.m3u8")
        self.assertEqual(variants["Normal"]["url"], "https://ruv-vod.akamaized.net/opid/example/540p/stream.m3u8")


if __name__ == "__main__":
    unittest.main()
