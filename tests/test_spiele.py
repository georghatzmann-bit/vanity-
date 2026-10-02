"""Spiele (Steam, Epic): installieren, starten, Updates, wie im Video, ohne Claude."""

import io
import json
import shutil
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

import tests.helpers  # noqa: F401
from jarvis import spiele
from jarvis.spiele import Games

GB = 1024 ** 3


def manifest(appid, name, flags=4, size=30 * GB):
    return (f'"AppState"\n{{\n\t"appid"\t\t"{appid}"\n\t"name"\t\t"{name}"\n\t"StateFlags"\t\t"{flags}"\n'
            f'\t"installdir"\t\t"{name}"\n\t"SizeOnDisk"\t\t"{size}"\n\t"buildid"\t\t"1"\n}}\n')


class FakeEnv:
    """Ein PC mit Steam in zwei Bibliotheken (C und F) und Epic Games, alles in einem Temp-Ordner."""

    def __init__(self, root: Path, libraries=2, epic=True):
        self.root = root
        self.steam = root / "Steam"
        self.second = root / "SteamLibrary"
        (self.steam / "steamapps").mkdir(parents=True)
        lines = ['"libraryfolders"', "{", '\t"0"', "\t{", f'\t\t"path"\t\t"{_escaped(self.steam)}"', "\t}"]
        if libraries > 1:
            (self.second / "steamapps").mkdir(parents=True)
            lines += ['\t"1"', "\t{", f'\t\t"path"\t\t"{_escaped(self.second)}"', "\t}"]
        lines += ['\t"2"', "\t{", '\t\t"path"\t\t"Z:\\\\Weg"', "\t}", "}"]  # gibt es nicht mehr
        (self.steam / "steamapps" / "libraryfolders.vdf").write_text("\n".join(lines), encoding="utf-8")
        self.epic = root / "Epic"
        if epic:
            self.epic.mkdir()
        self.opened = []
        self.steam_running = True
        self.free = {str(self.steam): 40 * GB, str(self.second): 400 * GB}
        self.dialogs = []
        self.dialog_ok = True
        self.on_sleep = None
        self.slept = 0

    def steam_root(self):
        return self.steam

    def epic_manifests(self):
        return self.epic

    def open_uri(self, uri):
        self.opened.append(uri)

    def running(self, names):
        return self.steam_running

    def free_bytes(self, path):
        return self.free.get(str(path), 0)

    def confirm_dialog(self, title, wait):
        self.dialogs.append((title, wait))
        return self.dialog_ok

    def sleep(self, seconds):
        self.slept += 1
        if self.on_sleep:
            self.on_sleep()

    def add(self, library: Path, appid, name, flags=4, size=30 * GB):
        (library / "steamapps" / f"appmanifest_{appid}.acf").write_text(manifest(appid, name, flags, size), encoding="utf-8")

    def add_epic(self, name, app, **extra):
        data = {"DisplayName": name, "AppName": app, "InstallLocation": f"D:\\Epic\\{name}", "InstallSize": 5 * GB,
                "bIsIncompleteInstall": False, **extra}
        (self.epic / f"{app}.item").write_text(json.dumps(data), encoding="utf-8")


def _escaped(path: Path) -> str:
    return str(path).replace("\\", "\\\\")


class FakeWeb:
    def __init__(self, search=None, details=None, offline=False):
        self.search = search or []
        self.details = details
        self.offline = offline
        self.urls = []

    def __call__(self, request, timeout=None):
        url = request.full_url
        self.urls.append(url)
        if self.offline:
            raise urllib.error.URLError("offline")
        if url.startswith(spiele.STORE_SEARCH):
            body = {"total": len(self.search), "items": [{"type": "app", "id": i, "name": n} for i, n in self.search]}
        elif url.startswith(spiele.APP_DETAILS):
            appid = url.split("appids=")[1].split("&")[0]
            body = {appid: {"success": True, "data": {"pc_requirements": {
                "minimum": f"<strong>Speicherplatz:</strong> {self.details} GB verfügbarer Speicherplatz"}}}} \
                if self.details else {appid: {"success": False}}
        else:
            raise urllib.error.URLError("unbekannt")
        return io.BytesIO(json.dumps(body).encode("utf-8"))


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.said = []
        self.offers = []
        self.watched = []
        self.pcs = 0

    def make(self, libraries=2, web=None, epic=True, cfg=None):
        self.pcs += 1
        env = FakeEnv(self.tmp / f"pc{self.pcs}", libraries=libraries, epic=epic)
        games = Games(cfg or {}, self.tmp / f"daten{self.pcs}", say=self.said.append, opener=web or FakeWeb(), env=env)
        games._background = lambda target, *args: self.watched.append(args)  # der Test ruft _watch_install selbst
        other = env.second if libraries > 1 else env.steam
        env.add(env.steam, "730", "Counter-Strike 2", flags=6)  # installiert, Update nötig
        env.add(env.steam, "228980", "Steamworks Common Redistributables", flags=6)
        env.add(other, "1966720", "Lethal Company")
        env.add(other, "271590", "Grand Theft Auto V", flags=4 | 1048576 | 256)  # lädt gerade
        env.add(other, "1086940", "Baldur's Gate 3", flags=1026)
        if epic:
            env.add_epic("Fortnite", "Fortnite", CatalogNamespace="fn", CatalogItemId="4fe75bbc5a674f4f9b356b5c90567da5")
            env.add_epic("Unreal Engine 5.4", "UE_5.4", AppCategories=["engines"])
        return games, env

    def offer(self, question, action):
        self.offers.append((question, action))


class NamesTest(unittest.TestCase):
    def test_spoken_names(self):
        self.assertEqual(spiele.compact("CS zwei"), "cs2")
        self.assertEqual(spiele.compact("c s 2"), "cs2")
        self.assertEqual(spiele.compact("R.E.P.O."), "repo")
        self.assertEqual(spiele.acronym("Counter-Strike 2"), "cs2")
        self.assertEqual(spiele.acronym("Grand Theft Auto V"), "gta5")
        self.assertEqual(spiele.acronym("Baldur's Gate 3"), "bg3")
        self.assertEqual(Games.wanted("GTA 5"), "Grand Theft Auto V")
        self.assertEqual(Games.wanted("Repo"), "R.E.P.O.")
        self.assertEqual(Games.score("cs2", "Counter-Strike 2"), 2)
        self.assertEqual(Games.score("Lethal", "Lethal Company"), 1)
        self.assertEqual(Games.score("Minecraft", "Lethal Company"), 0)

    def test_vdf_and_sizes(self):
        data = spiele.parse_vdf('"libraryfolders"\n{\n "0" { "path" "C:\\\\Program Files (x86)\\\\Steam" // Kommentar\n'
                                ' "apps" { "730" "123" } }\n "1" "D:\\\\Alt" }')
        self.assertEqual(data["libraryfolders"]["0"]["path"], "C:\\Program Files (x86)\\Steam")
        self.assertEqual(data["libraryfolders"]["0"]["apps"], {"730": "123"})
        self.assertEqual(data["libraryfolders"]["1"], "D:\\Alt", "das alte Format: nur der Pfad")
        self.assertEqual(spiele.parse_size("<strong>Speicherplatz:</strong> 85 GB verfügbarer Speicherplatz"), 85 * GB)
        self.assertEqual(spiele.parse_size("<li><strong>Storage:</strong> 1.5 GB available space</li>"), int(1.5 * GB))
        self.assertEqual(spiele.parse_size("Grafik: 4 GB VRAM"), 0, "Grafikspeicher ist kein Platzbedarf")
        self.assertEqual(spiele.drive_name("F:\\SteamLibrary"), "Laufwerk F")
        self.assertEqual(spiele.gigabytes(85 * GB), "85 GB")
        self.assertEqual(spiele.gigabytes(int(1.5 * GB)), "1,5 GB")


class LibraryTest(Base):
    def test_libraries_and_games(self):
        games, env = self.make()
        self.assertEqual(games.libraries(), [str(env.steam), str(env.second)], "Z:\\Weg gibt es nicht mehr")
        found = {g.name: g for g in games.installed()}
        self.assertEqual(set(found), {"Counter-Strike 2", "Steamworks Common Redistributables", "Lethal Company",
                                      "Grand Theft Auto V", "Baldur's Gate 3", "Fortnite"}, "die Unreal Engine ist kein Spiel")
        self.assertTrue(found["Counter-Strike 2"].needs_update)
        self.assertTrue(found["Baldur's Gate 3"].needs_update, "Update begonnen")
        self.assertTrue(found["Grand Theft Auto V"].downloading)
        self.assertFalse(found["Lethal Company"].needs_update)
        self.assertTrue(found["Steamworks Common Redistributables"].tool)
        self.assertEqual(found["Fortnite"].store, "epic")

    def test_same_folder_written_differently(self):
        games, env = self.make()
        spelled = str(env.steam).replace("/pc", "/./pc") + "/"  # anders geschrieben, derselbe Ordner
        env.steam_root = lambda: Path(spelled)
        self.assertEqual(games.libraries(), [str(env.steam), str(env.second)])
        self.assertEqual(len([g for g in games.installed(fresh=True) if g.name == "Counter-Strike 2"]), 1)

    def test_find_by_what_georg_says(self):
        games, _ = self.make()
        for said, name in [("CS2", "Counter-Strike 2"), ("cs zwei", "Counter-Strike 2"), ("Counter Strike", "Counter-Strike 2"),
                           ("GTA 5", "Grand Theft Auto V"), ("Lethal", "Lethal Company"), ("BG3", "Baldur's Gate 3"),
                           ("Fortnite", "Fortnite")]:
            self.assertEqual(games.find_installed(said).name, name, said)
        self.assertIsNone(games.find_installed("Minecraft"))
        self.assertIsNone(games.find_installed("Steamworks"), "Zusatzpakete sind keine Spiele")

    def test_no_steam(self):
        env_root = self.tmp / "leer"
        env_root.mkdir()
        env = FakeEnv(env_root)
        env.steam_root = lambda: None
        games = Games({}, self.tmp / "daten", say=self.said.append, opener=FakeWeb(search=[("1", "Palworld")]), env=env)
        self.assertEqual(games.libraries(), [])
        self.assertIsNone(games.install("Palworld"), "ohne Steam: Claude soll es versuchen")


class InstallTest(Base):
    def test_like_the_video_two_drives(self):
        web = FakeWeb(search=[("3164500", "Schedule I"), ("999", "Schedule I Soundtrack")], details=12)
        games, env = self.make(web=web)
        answer = games.install("Schedule eins", offer=self.offer)
        self.assertEqual(env.opened, ["steam://install/3164500"])
        self.assertIn("Der Steam-Dialog für Schedule I ist offen", answer)
        self.assertIn(f"Nehmen Sie {spiele.drive_name(env.second)}, dort ist am meisten Platz", answer)
        self.assertIn("Es braucht etwa 12 GB", answer)
        # Georg wählt das Laufwerk und klickt Installieren: die appmanifest taucht dort auf
        env.on_sleep = lambda: env.add(env.second, "3164500", "Schedule I", flags=1026)
        games._watch_install("3164500", "Schedule I", {str(env.steam): False, str(env.second): False}, True, False)
        self.assertEqual(env.dialogs, [], "bei zwei Laufwerken drückt Jarvis nichts selbst")
        self.assertEqual(self.said, [f"Schedule I lädt jetzt auf {spiele.drive_name(env.second)} herunter, Sir."])
        self.assertEqual(self.watched[-1][4], False, "nicht selbst bestätigen")
        self.assertEqual(json.loads((games._dir / spiele.CACHE_FILE).read_text(encoding="utf-8"))["schedule1"]["id"],
                         "3164500", "das nächste Mal ohne Suche")

    def test_one_library_jarvis_confirms(self):
        web = FakeWeb(search=[("1623730", "Palworld")])
        games, env = self.make(libraries=1, web=web)
        answer = games.install("Palworld")
        self.assertEqual(answer, "Sehr wohl, Sir. Palworld wird installiert.")
        self.assertEqual(self.watched[-1][4], True, "nur eine Bibliothek: Jarvis bestätigt selbst")
        env.on_sleep = lambda: env.add(env.steam, "1623730", "Palworld", flags=1026)
        games._watch_install("1623730", "Palworld", {str(env.steam): False}, True, True)
        self.assertEqual(env.dialogs, [("Palworld", 6.0)])
        self.assertEqual(self.said[-1], f"Palworld lädt jetzt auf {spiele.drive_name(env.steam)} herunter, Sir.")
        # Steam lief noch nicht: länger auf den Dialog warten; kommt der Download nicht, sagt Jarvis es
        env.dialogs.clear()
        env.on_sleep = None
        games._watch_install("42", "Ein Spiel", {str(env.steam): False}, False, True)
        self.assertEqual(env.dialogs, [("Ein Spiel", 30.0)])
        self.assertIn("Der Steam-Dialog für Ein Spiel wartet noch", self.said[-1])

    def test_cs2_needs_no_search_and_installed_games_are_offered(self):
        web = FakeWeb()
        games, env = self.make(web=web)
        answer = games.install("CS2", offer=self.offer)
        self.assertEqual(answer, "Counter-Strike 2 ist schon installiert, Sir, braucht aber ein Update. "
                                 "Soll ich die Steam-Downloads öffnen?")
        self.assertEqual(self.offers[-1][1](), "Die Steam-Downloads sind offen, Sir. Dort stehen die Updates an.")
        self.assertEqual(env.opened, ["steam://open/downloads"])
        self.assertEqual(games.install("Lethal Company", offer=self.offer),
                         "Lethal Company ist schon installiert, Sir. Soll ich es starten?")
        self.assertEqual(self.offers[-1][1](), "Lethal Company startet, Sir.")
        self.assertEqual(env.opened[-1], "steam://rungameid/1966720")
        self.assertEqual(games.install("GTA 5"), "Grand Theft Auto V lädt gerade herunter, Sir.")
        (env.steam / "steamapps" / "appmanifest_730.acf").unlink()
        games.installed(fresh=True)
        self.assertIn("Counter-Strike 2", games.install("CS2"))
        self.assertEqual(env.opened[-1], "steam://install/730")
        self.assertFalse(any("storesearch" in u for u in web.urls), "CS2 kennt Jarvis ohne Suche")

    def test_unclear_names_go_to_claude(self):
        for said, hits in [("Minecraft", [("1928870", "Minecraft Dungeons")]),
                           ("Python", [("1882420", "Learn Programming: Python - Remake")]),
                           ("VLC", [("2367420", "Kletba Vlčího Moru")])]:
            games, env = self.make(web=FakeWeb(search=hits))
            self.assertIsNone(games.install(said, offer=self.offer), said)
            self.assertEqual(env.opened, [], f"{said}: nichts Falsches installieren")
        self.assertEqual(self.offers, [])

    def test_not_enough_space_and_offline(self):
        games, env = self.make(web=FakeWeb(search=[("2", "Riesenspiel")], details=500))
        answer = games.install("Riesenspiel")
        self.assertIn("so viel Platz ist auf keinem Laufwerk frei", answer)
        self.assertIn("Am meisten hat", answer)
        offline, _ = self.make(web=FakeWeb(offline=True))
        self.assertIsNone(offline.install("Palworld"), "Shop nicht erreichbar: Claude versucht es")
        nothing, _ = self.make(web=FakeWeb(search=[]))
        self.assertIsNone(nothing.install("Gibtsnicht"))

    def test_epic_only_games(self):
        games, env = self.make(epic=False)
        self.assertIn("Epic-Launcher", games.install("Rocket League"))
        self.assertEqual(env.opened, ["com.epicgames.launcher://apps/Sugar?action=install"])
        games2, env2 = self.make()
        self.assertEqual(games2.launch("Fortnite"), "Fortnite startet, Sir.")
        self.assertEqual(env2.opened[-1], "com.epicgames.launcher://apps/fn%3A4fe75bbc5a674f4f9b356b5c90567da5%3AFortnite"
                                          "?action=launch&silent=true", "so wie Epics eigene Verknüpfungen")


class UpdatesTest(Base):
    def test_updates_like_the_video(self):
        games, env = self.make()
        answer = games.updates(offer=self.offer)
        self.assertEqual(answer, "Ich habe die Bibliotheken geprüft, Sir. Counter-Strike 2, Baldur's Gate 3 und ein paar "
                                 "Steam-Zusatzpakete haben Updates. Gerade lädt Steam: Grand Theft Auto V. Bei Epic Games "
                                 "prüft der Launcher die Updates selbst. Soll ich die Steam-Downloads öffnen?")
        self.assertEqual(self.offers[-1][1](), "Die Steam-Downloads sind offen, Sir. Dort stehen die Updates an.")
        self.assertEqual(env.opened, ["steam://open/downloads"])

    def test_all_current(self):
        games, env = self.make(epic=False)
        for appid in ("730", "228980", "271590", "1086940"):
            for lib in (env.steam, env.second):
                path = lib / "steamapps" / f"appmanifest_{appid}.acf"
                if path.exists():
                    path.unlink()
        self.assertEqual(games.updates(offer=self.offer), "Ich habe die Bibliotheken geprüft, Sir. Lethal Company ist aktuell.")
        self.assertEqual(self.offers, [])

    def test_voice_phrases(self):
        games, env = self.make()
        for text in ("Welche Spiele brauchen Updates?", "Jarvis, gibt es Updates für meine Spiele?",
                     "Brauchen meine Spiele Updates", "Sind meine Spiele aktuell?", "Spiele-Updates"):
            self.assertTrue(games.command(text).startswith("Ich habe die Bibliotheken geprüft"), text)
        self.assertTrue(games.command("Welche Spiele habe ich installiert?").startswith("Sie haben 5 Spiele installiert"))
        self.assertEqual(games.command("Deinstalliere Lethal Company"),
                         "Steam fragt gleich nach, ob Lethal Company wirklich weg soll, Sir.")
        self.assertEqual(env.opened[-1], "steam://uninstall/1966720")
        for text in ("Lösche die Erinnerung", "Wie wird das Wetter?", "Öffne Spotify", "Deinstalliere Gibtsnicht",
                     "Updates für Windows"):
            self.assertIsNone(games.command(text), text)
        self.assertTrue(spiele.is_command("Hey Jarvis, welche Spiele brauchen Updates?"), "Vorab-Erkennung: sofort los")
        self.assertFalse(spiele.is_command("Welche Spiele sind gerade beliebt"))
        from jarvis.voice import VoiceLoop

        self.assertTrue(VoiceLoop._is_command("Sind meine Spiele aktuell?"), "legt nach einer halben Sekunde los")
        self.assertTrue(VoiceLoop._is_command("Installiere CS2"))


class AssistantTest(Base):
    def test_install_start_and_yes(self):
        from jarvis import apps
        from tests.test_assistant import FakeBrain, make as make_assistant

        brain = FakeBrain()
        assistant, ui, speaker, _ = make_assistant(brain)
        games, env = self.make(web=FakeWeb(search=[("1623730", "Palworld")]))
        assistant.games = games
        self.assertEqual(assistant.handle("Installier mal schnell Palworld"),
                         f"Sehr wohl, Sir. Der Steam-Dialog für Palworld ist offen. Nehmen Sie "
                         f"{spiele.drive_name(env.second)}, dort ist am meisten Platz.")
        self.assertEqual(env.opened[-1], "steam://install/1623730")
        with mock.patch.object(apps, "open_app", side_effect=apps.AppNotFound("cs2")):
            self.assertEqual(assistant.handle("Starte CS2"), "Counter-Strike 2 startet, Sir. Vorher kommt noch ein Update.")
        self.assertEqual(env.opened[-1], "steam://rungameid/730")
        self.assertEqual(assistant.handle("Installiere Lethal Company"),
                         "Lethal Company ist schon installiert, Sir. Soll ich es starten?")
        self.assertEqual(assistant.handle("Ja"), "Lethal Company startet, Sir.")
        self.assertEqual(env.opened[-1], "steam://rungameid/1966720")
        self.assertTrue(assistant.handle("Welche Spiele brauchen Updates?").endswith("Soll ich die Steam-Downloads öffnen?"))
        self.assertEqual(assistant.handle("Ja, mach"), "Die Steam-Downloads sind offen, Sir. Dort stehen die Updates an.")
        self.assertEqual(brain.asked, [], "alles ohne Claude")
        done = [e[1] for e in ui.of("progress") if e[1]["state"] == "done"]
        self.assertTrue(any(step["label"].startswith("Installiert") for step in done))


if __name__ == "__main__":
    unittest.main()
