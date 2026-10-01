"""Programme öffnen, schließen und installieren, und die Sofort-Befehle dafür."""

import time
import unittest
from unittest import mock

import tests.helpers  # noqa: F401
from jarvis import apps, intents
from jarvis.apps import StartMenu, WingetResult, best_match, find_known
from tests.test_assistant import FakeBrain, make

START_MENU = [
    ("Spotify", "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"),
    ("Steamworks Common Redistributables", "steam://redist"),
    ("Steam", "{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}\\Steam\\steam.exe"),
    ("Google Chrome", "Chrome"),
    ("Uninstall Discord", "discord-uninstall"),
    ("Discord", "com.squirrel.Discord.Discord"),
    ("Rechner", "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"),
    ("Datei-Explorer", "Microsoft.Windows.Explorer"),
    ("Minecraft Launcher", "Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft"),
    ("Visual Studio Code", "Microsoft.VisualStudioCode"),
    ("Wallpaper Engine", "steam://rungameid/431960"),
]


class FindAppTest(unittest.TestCase):
    def test_known_apps_by_spoken_name(self):
        cases = {
            "Spotify": "Spotify", "spotifei": "Spotify", "Discord": "Discord", "discort": "Discord",
            "VS Code": "Visual Studio Code", "chrome": "Google Chrome", "Epic Games": "Epic Games Launcher",
            "Taschenrechner": "Rechner", "OBS": "OBS Studio", "Spotify.Spotify": "Spotify",
        }
        for said, name in cases.items():
            with self.subTest(said=said):
                self.assertEqual(find_known(said).name, name)
        self.assertIsNone(find_known("Zaubertrank"))
        self.assertIsNone(find_known(""))

    def test_start_menu_matching(self):
        cases = {
            "spotify": "Spotify", "Steam": "Steam", "chrome": "Google Chrome", "discord": "Discord",
            "explorer": "Datei-Explorer", "minecraft": "Minecraft Launcher", "taschenrechner": "Rechner",
            "vs code": "Visual Studio Code", "wallpaper engine": "Wallpaper Engine", "Spotfy": "Spotify",
        }
        for said, name in cases.items():
            with self.subTest(said=said):
                self.assertEqual(best_match(said, START_MENU)[0], name)
        for said in ("zauberei", "einen timer für 5 minuten", "", "de"):
            with self.subTest(said=said):
                self.assertIsNone(best_match(said, START_MENU))

    def test_open_uses_the_start_menu_then_websites(self):
        menu = StartMenu(loader=lambda: list(START_MENU))
        with mock.patch("jarvis.apps._launch") as launch, mock.patch("os.name", "nt"):
            self.assertEqual(apps.open_app("Spotify", menu), "Spotify startet.")
            launch.assert_called_with("shell:AppsFolder\\SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify")
            self.assertEqual(apps.open_app("YouTube", menu), "YouTube ist offen.")
            launch.assert_called_with("https://www.youtube.com")
            # Nicht installiert, aber mit Webseite
            self.assertEqual(apps.open_app("WhatsApp", menu), "WhatsApp ist offen.")
            with self.assertRaises(apps.AppNotFound):
                apps.open_app("Zaubertrank", menu)

    def test_start_menu_never_makes_opening_wait(self):
        calls = []

        def loader():
            calls.append(1)
            return list(START_MENU) + ([("Neu Installiert", "neu")] if len(calls) > 1 else [])

        def wait_for(count):
            end = time.monotonic() + 3
            while len(calls) < count and time.monotonic() < end:
                time.sleep(0.01)
            time.sleep(0.05)

        menu = StartMenu(loader=loader)
        menu.warm()  # beim Start im Hintergrund
        self.assertEqual(menu.find("spotify")[0], "Spotify")  # wartet höchstens auf dieses erste Laden
        self.assertEqual(len(calls), 1)
        self.assertEqual(menu.find("steam")[0], "Steam")
        self.assertEqual(len(calls), 1, "zwischengespeichert")
        # Fehlt ein Name (gerade erst installiert?), wird nicht gewartet, aber im Hintergrund neu gelesen.
        menu._loaded_at -= StartMenu.MISS_REFRESH + 1
        self.assertIsNone(menu.find("neu installiert"))
        wait_for(2)
        self.assertEqual(menu.find("neu installiert"), ("Neu Installiert", "neu"))
        # Eine alte Liste gilt weiter, bis die neue im Hintergrund fertig ist.
        menu._loaded_at -= StartMenu.MAX_AGE + 1
        started = time.monotonic()
        self.assertEqual(menu.find("spotify")[0], "Spotify")
        self.assertLess(time.monotonic() - started, 0.05)
        wait_for(3)
        self.assertEqual(len(calls), 3)

    def test_websites_win_over_similar_programs(self):
        entries = list(START_MENU) + [("Amazon Music", "amazon-music"), ("YouTube", "youtube-pwa")]
        menu = StartMenu(loader=lambda: entries)
        with mock.patch("jarvis.apps._launch") as launch, mock.patch("os.name", "nt"):
            self.assertEqual(apps.open_app("Amazon", menu), "Amazon ist offen.")
            launch.assert_called_with("https://www.amazon.de")
            self.assertEqual(apps.open_app("YouTube", menu), "YouTube startet.")  # genau so installiert
            launch.assert_called_with("shell:AppsFolder\\youtube-pwa")
            self.assertEqual(apps.open_app("amazon.de", menu), "Amazon ist offen.")
            self.assertEqual(apps.open_app("orf punkt at", menu), "ORF ist offen.")
            launch.assert_called_with("https://orf.at")
            self.assertEqual(apps.open_app("Geräte-Manager", menu), "Geräte-Manager ist offen.")
            launch.assert_called_with("devmgmt.msc")

    def test_closing_finds_the_right_processes(self):
        running = [("Discord.exe", 10), ("Discord.exe", 11), ("python.exe", 12), ("chrome.exe", 13), ("steam.exe", 14)]
        known, hits = apps.matching_processes("Discord", running)
        self.assertEqual(known.name, "Discord")
        self.assertEqual(hits, [("Discord.exe", 10), ("Discord.exe", 11)])
        self.assertEqual(apps.matching_processes("Python", running)[1], [])  # sich selbst nie
        self.assertEqual(apps.matching_processes("Chrome", running)[1], [("chrome.exe", 13)])
        self.assertEqual(apps.matching_processes("xy", running)[1], [])


class InstallTest(unittest.TestCase):
    def run_install(self, results):
        calls = []

        def fake(args, timeout=600):
            calls.append(args)
            return results.pop(0)

        with mock.patch("jarvis.apps.winget", side_effect=fake), mock.patch.object(apps.START_MENU, "apps"):
            try:
                return apps.install("Spotify"), calls
            except apps.AppError as exc:
                return exc, calls

    def test_installs_for_the_user_first(self):
        said, calls = self.run_install([WingetResult(0, "Successfully installed")])
        self.assertEqual(said, "Spotify ist installiert.")
        self.assertIn("Spotify.Spotify", calls[0])
        self.assertEqual(calls[0][-2:], ["--scope", "user"])
        self.assertIn("--silent", calls[0])

    def test_falls_back_to_all_users_then_to_the_store(self):
        said, calls = self.run_install([
            WingetResult(-1978335212, "No applicable installer found"),
            WingetResult(1, "Installer failed with exit code: 1603"),
            WingetResult(0, "Successfully installed"),
        ])
        self.assertEqual(said, "Spotify ist installiert.")
        self.assertNotIn("--scope", calls[1])
        self.assertEqual(calls[2][calls[2].index("--id") + 1], "9NCBCSZSJRSB")
        self.assertIn("msstore", calls[2])

    def test_already_installed(self):
        said, _ = self.run_install([WingetResult(-1978335189, "Found an existing package already installed.")])
        self.assertEqual(said, "Spotify ist schon installiert.")

    def test_failure_names_the_reason(self):
        said, _ = self.run_install([WingetResult(1, "Download failed\nNetzwerkfehler 0x80072efd")] * 2)
        self.assertIsInstance(said, apps.AppError)
        self.assertIn("0x80072efd", str(said))


class LocalCommandTest(unittest.TestCase):
    def test_intents(self):
        cases = {
            "Öffne Spotify": ("open", "spotify"),
            "Jarvis, öffne mal Spotify.": ("open", "spotify"),
            "Kannst du Discord starten?": ("open", "discord"),
            "Mach Spotify auf": ("open", "spotify"),
            "Mach Spotify an": ("open", "spotify"),
            "Zeig mir YouTube": ("open", "youtube"),
            "Schließe Discord": ("close", "discord"),
            "Mach Steam zu": ("close", "steam"),
            "Installiere Spotify": ("install", "spotify"),
            "Lad mir Spotify runter.": ("install", "spotify"),
            "Spotify installieren": ("install", "spotify"),
            "Gaming Mode an": ("gaming_on", ""),
            "Mach den Gaming-Modus an.": ("gaming_on", ""),
            "Gamingmodus aus": ("gaming_off", ""),
            "Beende den Gaming Modus": ("gaming_off", ""),
            "Zeig dich": ("window_show", ""),
            "Jarvis, versteck dich.": ("window_hide", ""),
            "Öffne deine Einstellungen": ("setup", ""),
            "Sperr den PC": ("lock", ""),
            "Öffne den Ordner Downloads": ("folder", "downloads"),
            "Spiel Musik ab": ("media_play", ""),
        }
        for text, (name, arg) in cases.items():
            with self.subTest(text=text):
                found = intents.match(text)
                self.assertIsNotNone(found)
                self.assertEqual((found.name, found.arg), (name, arg))
        for text in ("Mach das Licht an", "Öffne es", "Ist Spotify geschlossen?", "Was ist das beste Programm zum Schneiden?",
                     "Ist der Gaming Modus aus?"):
            with self.subTest(text=text):
                found = intents.match(text)
                self.assertTrue(found is None or found.name not in ("open", "close", "install", "gaming_off"), found)

    def test_open_is_instant_and_unknown_goes_to_claude(self):
        brain = FakeBrain()
        assistant, ui, speaker, _ = make(brain)
        with mock.patch("jarvis.apps.open_app", return_value="Spotify startet.") as open_app:
            answer = assistant.handle("Öffne Spotify")
        open_app.assert_called_once_with("spotify")
        self.assertIn("Spotify", answer)
        self.assertEqual(brain.asked, [])
        with mock.patch("jarvis.apps.open_app", side_effect=apps.AppNotFound("weg")):
            assistant.handle("Öffne den Zaubertrank")
        self.assertEqual(brain.asked, ["Öffne den Zaubertrank"])

    def test_install_runs_in_the_background_and_reports(self):
        assistant, ui, speaker, _ = make(FakeBrain())

        def slow_install(name):
            time.sleep(0.2)
            return f"{name} ist installiert."

        with mock.patch("jarvis.apps.install", side_effect=slow_install), \
                mock.patch("jarvis.apps.open_app", return_value="Spotify startet."):
            started = time.monotonic()
            answer = assistant.handle("Installier mir Spotify")
            self.assertLess(time.monotonic() - started, 0.15)
            self.assertIn("Spotify", answer)
            self.assertIn("installier", answer.lower())
            for _ in range(50):
                if any("ist installiert" in s for s in speaker.said):
                    break
                time.sleep(0.02)
        self.assertTrue(any("Spotify ist installiert" in s for s in speaker.said), speaker.said)

    def test_unknown_program_install_goes_to_claude(self):
        brain = FakeBrain()
        assistant, *_ = make(brain)
        assistant.handle("Installiere Zauberprogramm")
        self.assertEqual(brain.asked, ["Installiere Zauberprogramm"])

    def test_gaming_mode(self):
        assistant, ui, *_ = make(FakeBrain())
        with mock.patch("jarvis.pc.gaming_mode", return_value="Gaming-Modus an.") as gaming:
            answer = assistant.handle("Gaming Mode an")
        gaming.assert_called_once()
        self.assertTrue(gaming.call_args.args[0])
        self.assertIn("Gaming-Modus", answer)
        self.assertTrue(assistant.gaming)
        self.assertIn(("config", {"gaming": True}), ui.events)
        with mock.patch("jarvis.pc.gaming_mode", return_value="Gaming-Modus aus."):
            assistant.handle("Gaming Modus aus")
        self.assertFalse(assistant.gaming)

    def test_window_commands(self):
        assistant, *_ = make(FakeBrain())
        self.assertIn("kein Fenster", assistant.handle("Zeig dich"))
        seen = []
        assistant.window_control = lambda what: seen.append(what) or True
        assistant.handle("Zeig dich")
        assistant.handle("Versteck dich")
        self.assertEqual(seen, ["show", "hide"])


if __name__ == "__main__":
    unittest.main()
