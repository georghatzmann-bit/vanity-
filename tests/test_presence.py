"""Hintergrund-Modus: Beim Weckwort erscheint das Fenster und verschwindet danach wieder."""

import time
import unittest

import tests.helpers  # noqa: F401
from jarvis.presence import Presence


class FakeWindow:
    def __init__(self):
        self.hidden = True
        self.events = []

    def show_quiet(self):
        self.hidden = False
        self.events.append("show_quiet")

    def hide(self):
        self.hidden = True
        self.events.append("hide")

    def settle(self):
        self.events.append("settle")


class PresenceTest(unittest.TestCase):
    def make(self, **kwargs):
        window = FakeWindow()
        presence = Presence(window, **kwargs)
        presence.HIDE_AFTER = 0.15
        return window, presence

    def test_appears_on_the_wake_word_and_leaves_after_the_conversation(self):
        window, presence = self.make()
        presence.state("listening")
        self.assertFalse(window.hidden)
        presence.state("thinking")
        presence.state("speaking")
        presence.state("idle")
        self.assertFalse(window.hidden, "nicht sofort weg")
        time.sleep(0.3)
        self.assertTrue(window.hidden)
        self.assertEqual(window.events, ["show_quiet", "hide"])

    def test_a_new_question_keeps_it_open(self):
        window, presence = self.make()
        presence.state("listening")
        presence.state("idle")
        time.sleep(0.05)
        presence.state("listening")  # Georg sagt gleich noch etwas
        time.sleep(0.25)
        self.assertFalse(window.hidden)

    def test_clicking_into_the_window_keeps_it(self):
        window, presence = self.make()
        presence.state("listening")
        presence.keep()
        presence.state("idle")
        time.sleep(0.3)
        self.assertFalse(window.hidden)
        self.assertIn("settle", window.events)

    def test_stays_away_while_gaming_and_open_while_the_workshop_works(self):
        window, presence = self.make(suppressed=lambda: True)
        presence.state("listening")
        self.assertTrue(window.hidden)
        busy = [True]
        window, presence = self.make(keep_open=lambda: busy[0])
        presence.state("listening")
        presence.state("idle")
        time.sleep(0.3)
        self.assertFalse(window.hidden, "die Werkstatt arbeitet noch")
        busy[0] = False
        time.sleep(0.3)
        self.assertTrue(window.hidden)

    def test_window_that_was_already_open_is_left_alone(self):
        window, presence = self.make()
        window.hidden = False
        presence.state("listening")
        presence.state("idle")
        time.sleep(0.3)
        self.assertEqual(window.events, [])


if __name__ == "__main__":
    unittest.main()
