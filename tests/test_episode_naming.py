import sys
import unittest
from pathlib import Path


SRC_DIR = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_DIR))

import ruvsarpur  # noqa: E402


class EpisodeNamingTests(unittest.TestCase):
    def test_available_episode_count_is_replaced_by_stable_episode_number(self):
        show = {
            "title": "Perlur sjónvarpsins (3 af 3)",
            "series_title": "Perlur sjónvarpsins",
            "ep_num": "3",
            "ep_total": "3",
            "season_num": "1",
            "multiple_episodes": True,
            "is_movie": False,
            "is_docu": False,
            "is_sport": False,
        }

        self.assertEqual(ruvsarpur.createShowTitle(show), "Perlur sjónvarpsins s01e03")
        self.assertEqual(ruvsarpur.createLocalFileName(show), "Perlur sjónvarpsins s01e03.mp4")


if __name__ == "__main__":
    unittest.main()
