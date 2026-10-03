"""Die Jarvis-Anzeige oben am Bildschirm: wann sie erscheint und wie sie gezeichnet wird."""

import time
import unittest
from unittest import mock

import tests.helpers  # noqa: F401
from jarvis import overlay
from jarvis.overlay import LINGER, Overlay, View, premultiplied_bgra, render


class OverlayLogicTest(unittest.TestCase):
    def test_shows_while_busy_and_lingers_after_the_answer(self):
        ov = Overlay()
        self.assertFalse(ov.wanted())
        ov.state("listening")
        self.assertTrue(ov.wanted())
        ov.message("user", "Öffne Spotify")
        ov.state("thinking")
        self.assertEqual(ov.view.text, "„Öffne Spotify“")
        ov.state("speaking")
        ov.message("jarvis", "Spotify läuft, Sir.", final=False)
        self.assertEqual(ov.view.text, "Spotify läuft, Sir.")
        ov.state("idle")
        self.assertTrue(ov.wanted())
        self.assertEqual(ov.view.text, "Spotify läuft, Sir.")
        self.assertFalse(ov.wanted(time.monotonic() + LINGER + 0.5))

    def test_nothing_heard_does_not_linger(self):
        ov = Overlay()
        ov.state("listening")
        ov.state("idle")
        self.assertFalse(ov.wanted())

    def test_suppressed_in_gaming_mode_or_when_jarvis_is_in_front(self):
        hide = [True]
        ov = Overlay(suppressed=lambda: hide[0])
        ov.state("listening")
        self.assertFalse(ov.wanted())
        hide[0] = False
        self.assertTrue(ov.wanted())

    def test_new_question_clears_the_old_answer(self):
        ov = Overlay()
        ov.state("speaking")
        ov.message("jarvis", "Alte Antwort.")
        ov.state("idle")
        ov.state("listening")
        self.assertEqual(ov.view.text, "")

    def test_shows_what_jarvis_is_doing(self):
        overlay = Overlay()
        overlay.state("thinking")
        overlay.progress({"id": "t1", "label": "Installiert Spotify", "state": "running"})
        self.assertEqual(overlay.view.activity, "Installiert Spotify")
        img = render(overlay.view, now=1.0)
        self.assertEqual(img.mode, "RGBA")
        overlay.progress({"id": "t1", "label": "Installiert Spotify", "state": "done"})
        self.assertEqual(overlay.view.activity, "")
        overlay.progress({"id": "w1", "label": "Schreibt bot.py", "state": "running", "workshop": True})
        self.assertEqual(overlay.view.activity, "", "Werkstatt-Schritte gehören ins Werkstatt-Fenster")

    def test_only_windows_gets_a_window(self):
        with mock.patch("os.name", "posix"):
            self.assertFalse(Overlay().start())


class OverlayDrawingTest(unittest.TestCase):
    def test_render_sizes_and_states(self):
        for state in ("listening", "thinking", "speaking", "muted", "idle", "error"):
            with self.subTest(state=state):
                img = render(View(state, "Ein ziemlich langer Satz, der nicht in eine Zeile passt, " * 3, 0.5), 3.0, 1.5)
                self.assertEqual(img.size, (round((overlay.WIDTH + 2 * overlay.PAD) * 1.5),
                                            round((overlay.HEIGHT + 2 * overlay.PAD) * 1.5)))
                # Ecken durchsichtig, Mitte deckend
                self.assertEqual(img.getpixel((0, 0))[3], 0)
                self.assertGreater(img.getpixel((img.size[0] // 2, img.size[1] // 2))[3], 200)

    def test_long_text_shows_the_newest_part(self):
        font = overlay._font(15)
        fitted = overlay._fit("Erster Satz ist kurz. Und dann kommt ein zweiter, sehr viel längerer Satz, "
                              "der garantiert nicht mehr in die Zeile passt und gekürzt werden muss.", font, 300)
        self.assertTrue(fitted.startswith("… "))
        self.assertTrue(fitted.endswith("gekürzt werden muss."))
        self.assertLessEqual(font.getlength(fitted), 300)

    def test_premultiplied_bgra(self):
        from PIL import Image

        img = Image.new("RGBA", (2, 1), (200, 100, 50, 128))
        data = premultiplied_bgra(img)
        self.assertEqual(len(data), 8)
        self.assertEqual(tuple(data[:4]), (25, 50, 100, 128))


if __name__ == "__main__":
    unittest.main()


class TitleBarColorTest(unittest.TestCase):
    def test_colorref_is_blue_green_red(self):
        from jarvis.desktop import colorref

        self.assertEqual(colorref("#080b11"), 0x00110B08)
        self.assertEqual(colorref("#ff0000"), 0x000000FF)
        self.assertEqual(colorref("0f1115"), 0x0015110F)

    def test_style_title_bar_does_nothing_off_windows(self):
        from jarvis.desktop import style_title_bar

        with mock.patch("jarvis.desktop.os.name", "posix"):
            self.assertFalse(style_title_bar("Jarvis", "#080b11"))
