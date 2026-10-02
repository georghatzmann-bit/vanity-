"""Die Weltlage ("Gottes Auge"): Orte zu Meldungen, Lagebericht mit Stimme, Kurse, Flüge, Sprachbefehle."""

import io
import json
import threading
import time
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

import tests.helpers  # noqa: F401
from jarvis import orte, weltlage
from jarvis.weltlage import Weltlage
from tests.helpers import RecordingUi


def raw_news(*entries):
    """Meldungen im Format der Tagesschau-Schnittstelle: (Titel, Dachzeile, erster Satz)."""
    return {"news": [{
        "sophoraId": f"id{i}", "title": title, "topline": top, "firstSentence": first, "type": "story",
        "tags": [{"tag": "Politik"}], "geotags": [],
        "teaserImage": {"imageVariants": {"16x9-384": f"https://images.tagesschau.de/bild{i}.jpg"}},
        "shareURL": f"https://www.tagesschau.de/meldung{i}.html", "date": "2026-10-02T18:00:00+02:00",
    } for i, (title, top, first) in enumerate(entries)]}


WORLD = raw_news(
    ("Russland greift wichtige Brücke in Kiew an", "Krieg gegen die Ukraine", "Die Südbrücke ist gesperrt."),
    ("Wahlkampf mit Schulpolitik?", "Melonis umstrittenes Dekret", "Italiens Regierung verschärft die Regeln an Schulen."),
    ("Wahlsiegerin Andersson soll es noch mal versuchen", "Regierungsbildung", "Die schwedische Sozialdemokratin bekommt den Auftrag."),
    ("Eine Meldung ganz ohne Ort", "Vermischtes", "Hier steht nichts über einen Ort."),
    ("Astronauten erreichen ISS in Rekordzeit", "Raumfahrt", "So schnell war noch keine Kapsel."),
    ("Russland greift wichtige Brücke in Kiew an", "Doppelt", "Dieselbe Meldung noch einmal."),
)
CHART = {"chart": {"result": [{"meta": {"regularMarketPrice": 25231.2, "chartPreviousClose": 24936.0}}]}}
ISS = {"latitude": 51.77, "longitude": -58.55, "altitude": 429.3}
STATES = {"states": [
    ["3c6444", "DLH4AB ", "Germany", 0, 0, 8.68, 50.11, 10000, False, 230.5, 90.0, 0, None, 10200, None, False, 0],
    ["3c6445", "DLH5CD ", "Germany", 0, 0, 9.0, 50.5, 0, True, 0, 0, 0, None, 0, None, False, 0],
    ["3c6446", None, "France", 0, 0, None, None, 1000, False, 100, 0, 0, None, None, None, False, 0],
]}


class FakeWeb:
    """Antwortet je nach Adresse; alles andere ist "offline"."""

    def __init__(self, routes=None):
        self.routes = dict(routes or {})
        self.calls = []

    def __call__(self, request, timeout=None):
        url = request.full_url
        self.calls.append(url)
        for prefix, body in self.routes.items():
            if url.startswith(prefix):
                if isinstance(body, Exception):
                    raise body
                return io.BytesIO(body if isinstance(body, bytes) else json.dumps(body).encode("utf-8"))
        raise urllib.error.URLError("offline")


def web(**extra):
    routes = {weltlage.NEWS_API + "?ressort=ausland": WORLD, weltlage.NEWS_API + "?ressort=inland": raw_news(
        ("Kabinett beschließt Pflegereform", "Gesundheit", "Die Beiträge steigen."),
        ("Mieten für Studierende steigen weiter", "Wohnen", "Spitzenreiter bleibt München.")),
        "https://query1.finance.yahoo.com/": CHART, weltlage.ISS_API: ISS, weltlage.FLIGHTS_API: STATES,
        weltlage.REVERSE_API: {"address": {"country": "Kanada"}}}
    routes.update(extra)
    return FakeWeb(routes)


class PlacesTest(unittest.TestCase):
    def test_the_most_exact_place_wins(self):
        self.assertEqual(orte.find("Russland greift wichtige Brücke in Kiew an").name, "Kiew")
        self.assertEqual(orte.find("Schröder wird Aufsichtsrat bei Globus in Russland").name, "Russland")
        self.assertEqual(orte.find("US-Botschafterin in Griechenland").name, "Griechenland")

    def test_genitive_adjectives_and_people(self):
        self.assertEqual(orte.find("Italiens Regierung verschärft die Regeln").name, "Italien")
        self.assertEqual(orte.find("Die schwedische Sozialdemokratin").name, "Schweden")
        self.assertEqual(orte.find("Niederlage für Sánchez").name, "Madrid")
        self.assertEqual(orte.find("Republikaner suchen Abstand zu Trump").name, "Washington")
        self.assertEqual(orte.find("EU schafft Basis für Abschiebezentren").name, "Brüssel")
        self.assertEqual(orte.find("Unruhen in der Ost-Ukraine").name, "Ukraine")

    def test_fields_in_order(self):
        self.assertEqual(orte.find("Wahlkampf mit Schulpolitik?", "Melonis Dekret", "In Frankreich nicht").name, "Rom")
        self.assertIsNone(orte.find("Eine Meldung ganz ohne Ort", "Vermischtes"))

    def test_words_that_only_look_like_places(self):
        self.assertIsNone(orte.find("Was es heute zum Essen gibt"))
        self.assertEqual(orte.find("Großbrand in Essen").name, "Essen")
        self.assertIsNone(orte.find("Das Porto für Briefe steigt"))
        self.assertIsNone(orte.find("Experten rügen die Regierung"))
        self.assertEqual(orte.find("Urlaub auf Rügen").name, "Rügen")
        self.assertIsNone(orte.find("Der Senat beschließt den Haushalt"), "der Berliner Senat ist nicht Washington")
        self.assertEqual(orte.find("Der US-Senat stimmt zu").name, "Washington")

    def test_space_station(self):
        self.assertEqual(orte.find("Astronauten erreichen ISS in Rekordzeit"), orte.WELTRAUM)

    def test_lookup_by_name(self):
        self.assertEqual(orte.lookup("Tokio").name, "Tokio")
        self.assertEqual(orte.lookup("tokyo").name, "Tokio")
        self.assertEqual(orte.lookup("Italiens").name, "Italien")
        self.assertEqual(orte.lookup("Sao Paulo").name, "São Paulo")
        self.assertIsNone(orte.lookup("Nirgendwo"))
        self.assertIsNone(orte.lookup(""))

    def test_zoom_hint(self):
        self.assertEqual(orte.lookup("Berlin").genau, 3)
        self.assertEqual(orte.lookup("Bayern").genau, 2)
        self.assertEqual(orte.lookup("Russland").genau, 1)


class SourcesTest(unittest.TestCase):
    def test_news_with_places_first(self):
        items = weltlage.fetch_news("welt", web(), limit=10)
        self.assertEqual([i["ort"]["name"] if i["ort"] else None for i in items],
                         ["Kiew", "Rom", "Schweden", "Raumstation ISS", None], "Doppelte fallen weg, ohne Ort ans Ende")
        first = items[0]
        self.assertEqual(first["sprechen"], "Russland greift wichtige Brücke in Kiew an.")
        self.assertEqual(first["bild"], "https://images.tagesschau.de/bild0.jpg")
        self.assertEqual(items[1]["sprechen"], "Wahlkampf mit Schulpolitik? Italiens Regierung verschärft die Regeln an Schulen.",
                         "eine Frage allein versteht niemand")
        iss = items[3]["ort"]
        self.assertEqual((iss["lat"], iss["lon"], iss["iss"]), (51.77, -58.55, True), "die Raumstation, wo sie gerade ist")
        self.assertEqual(len(weltlage.fetch_news("welt", web(), limit=2)), 2)

    def test_photos_small_big_caption_and_source(self):
        raw = {"title": "Wahlsiegerin Andersson soll es noch mal versuchen", "topline": "Schweden", "teaserImage": {
            "alttext": "Magdalena  Andersson\nim Parlament", "copyright": " AFP ", "imageVariants": {
                "16x9-256": "https://images.tagesschau.de/klein.jpg", "16x9-384": "https://images.tagesschau.de/mittel.jpg",
                "16x9-960": "https://images.tagesschau.de/gross.jpg", "1x1-144": "http://unsicher.example/bild.jpg"}}}
        item = weltlage.to_item(raw, "ausland")
        self.assertEqual(item["bild"], "https://images.tagesschau.de/mittel.jpg", "fürs Listenbild reicht 384 Pixel")
        self.assertEqual(item["bild_gross"], "https://images.tagesschau.de/gross.jpg")
        self.assertEqual(item["bild_text"], "Magdalena Andersson im Parlament")
        self.assertEqual(item["bild_quelle"], "AFP")
        bare = weltlage.to_item({"title": "Eine Meldung ohne Foto", "topline": "Schweden",
                                 "teaserImage": {"imageVariants": {"1x1-144": "http://unsicher.example/bild.jpg"}}}, "ausland")
        self.assertEqual((bare["bild"], bare["bild_gross"], bare["bild_text"], bare["bild_quelle"]), ("", "", "", ""),
                         "nur https-Bilder, sonst zeigt das Fenster ein Satellitenbild vom Ort")
        small_only = weltlage.to_item({"title": "Nur ein kleines Foto", "teaserImage": {"imageVariants": {
            "16x9-256": "https://images.tagesschau.de/klein.jpg"}}}, "ausland")
        self.assertEqual(small_only["bild_gross"], "https://images.tagesschau.de/klein.jpg", "groß = das größte, das es gibt")

    def test_inland_without_place_is_germany(self):
        items = weltlage.fetch_news("deutschland", web())
        self.assertEqual([i["ort"]["name"] for i in items], ["Deutschland", "München"])

    def test_news_offline(self):
        with self.assertRaises(urllib.error.URLError):
            weltlage.fetch_news("welt", FakeWeb())

    def test_markets(self):
        markets = weltlage.fetch_markets(web())
        self.assertEqual([m["name"] for m in markets], ["DAX", "S&P 500", "Bitcoin"])
        self.assertEqual(markets[0]["prozent"], 1.18)
        text = weltlage.markets_sentence(markets[:1] + [{"name": "Bitcoin", "wert": 75399.7, "prozent": -0.05, "einheit": "Euro"}])
        self.assertEqual(text, "Der DAX steht bei 25.231 Punkten, plus 1,2 Prozent. Bitcoin steht bei 75.400 Euro, minus 0,1 Prozent.")
        self.assertEqual(weltlage.fetch_markets(FakeWeb()), [])
        self.assertIn("nicht heran", weltlage.markets_sentence([]))

    def test_flights_only_in_the_air(self):
        planes = weltlage.fetch_flights((47, 5, 55, 15), web())
        self.assertEqual(len(planes), 1)
        self.assertEqual(planes[0]["ruf"], "DLH4AB")
        self.assertEqual((planes[0]["kurs"], planes[0]["tempo"], planes[0]["hoehe"]), (90.0, 230.5, 10200))

    def test_geocode(self):
        self.assertEqual(weltlage.geocode("Tokio", FakeWeb()).name, "Tokio", "eigenes Verzeichnis, ohne Internet")
        found = weltlage.geocode("Ulan Bator", web(**{weltlage.GEOCODE_API: [
            {"name": "Ulaanbaatar", "lat": "47.9", "lon": "106.9", "boundingbox": ["47.7", "48.1", "106.5", "107.3"]}]}))
        self.assertEqual((found.name, found.lat, found.lon), ("Ulaanbaatar", 47.9, 106.9))
        self.assertIsNone(weltlage.geocode("Atlantis", web(**{weltlage.GEOCODE_API: []})))
        self.assertIsNone(weltlage.geocode("Atlantis", FakeWeb()))


class Voice:
    """Stimme zum Mitschreiben: say merkt sich, wait kommt sofort zurück (oder hält an, bis frei)."""

    def __init__(self):
        self.said = []
        self.hushed = 0
        self.gate = threading.Event()
        self.gate.set()

    def say(self, text):
        self.said.append(text)

    def wait(self, timeout=None):
        # Langes Warten (der Anfang "Lagebericht, Sir.") ist sofort fertig, die kurzen Nachfragen beim
        # Vorlesen hängen am Tor: Ist es zu, "spricht" Jarvis noch
        if timeout is None or timeout >= 1:
            return True
        return self.gate.wait(timeout)

    def hush(self):
        self.hushed += 1


def make(opener=None, cfg=None, active=False):
    ui = RecordingUi()
    voice = Voice()
    world = Weltlage(cfg or {}, ui, voice.say, voice.wait, hush=voice.hush, opener=opener or web())
    world.active = active
    return world, ui, voice


def wait_for(check, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if check():
            return True
        time.sleep(0.02)
    raise AssertionError("Zustand trat nicht ein")


class CommandTest(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(weltlage, "PAUSE_BETWEEN", 0.0)
        patcher.start()
        self.addCleanup(patcher.stop)

    def actions(self, ui):
        return [e[1]["action"] for e in ui.of("world")]

    def test_briefing_phrases(self):
        for text, kind in [("Jarvis, zeig mir, was in der Welt passiert", "welt"), ("Was passiert gerade in der Welt?", "welt"),
                           ("Lagebericht", "welt"), ("Gib mir die Weltlage", "welt"), ("Nachrichten aus aller Welt", "welt"),
                           ("Sag mir, was in Deutschland passiert", "deutschland"), ("Was ist los in Deutschland?", "deutschland"),
                           ("Wirtschaftsnachrichten", "wirtschaft")]:
            world, ui, _ = make()
            with mock.patch.object(world, "briefing", return_value="ok") as brief:
                self.assertEqual(world.command(text), "ok", text)
            brief.assert_called_once_with(kind)

    def test_not_for_the_world(self):
        world, _, _ = make()
        for text in ("Öffne Spotify", "Wie spät ist es?", "Zeig mir Paris", "Zurück zum Hauptmenü", "Weiter", "Zoom rein"):
            self.assertIsNone(world.command(text), text)
        world.active = True
        for text in ("Zeig mir die Blaupause", "Zeig mir meine Termine", "Öffne Spotify"):
            self.assertIsNone(world.command(text), text)

    def test_open_and_close(self):
        world, ui, _ = make()
        self.assertEqual(world.command("Zeig mir die Erde"), "Satellitenverbindung steht, Sir.")
        self.assertTrue(world.active)
        self.assertEqual(world.command("Zurück zum Hauptmenü"), "Sehr wohl, Sir.")
        self.assertFalse(world.active)
        self.assertEqual(self.actions(ui), ["open", "close"])
        self.assertEqual(world.command("Gottes Auge"), "Satellitenverbindung steht, Sir.")

    def test_fly(self):
        world, ui, _ = make()
        self.assertEqual(world.command("Flieg nach Tokio"), "Kurs auf Tokio, Sir.")
        self.assertEqual(self.actions(ui), ["open", "fly"])
        self.assertEqual(ui.of("world")[-1][1]["ort"]["name"], "Tokio")
        self.assertEqual(world.command("Zeig mir Paris"), "Kurs auf Paris, Sir.", "bei offener Erde reicht zeig mir")
        self.assertIsNone(world.command("Zeig mir Quatschhausen"), "ohne bekannten Ort: weiter an Claude")
        self.assertIn("finde ich auf der Karte nicht", world.command("Flieg nach Quatschhausen"))
        self.assertEqual(world.command("Navigiere nach München"), "Kurs auf München, Sir.")
        self.assertEqual(world.command("Bring mich nach Japan"), "Kurs auf Japan, Sir.")

    def test_everyday_commands_still_work_while_the_earth_is_open(self):
        searched = []

        def opener(request, timeout=0):  # die Ortssuche im Internet fände zu fast allem irgendetwas
            searched.append(request.full_url)
            raise OSError("nicht fragen")

        world, ui, _ = make(opener)
        world.active = True
        for text in ("Geh in den Gaming-Modus", "Gehe zu Discord", "Geh auf YouTube", "Navigiere zu Google",
                     "Spring zum Anfang", "Bring mich zu meinen Downloads", "Geh nach oben"):
            self.assertIsNone(world.command(text), text)
        self.assertEqual(searched, [])
        self.assertEqual(world.command("Geh ins Hauptmenü"), "Sehr wohl, Sir.")
        self.assertFalse(world.active)

    def test_iss(self):
        world, ui, _ = make()
        self.assertEqual(world.command("Wo ist die ISS gerade?"),
                         "Die Raumstation fliegt gerade über Kanada, Sir, in 429 Kilometern Höhe.")
        self.assertTrue(ui.of("world")[-1][1]["ort"]["iss"])
        offline, _, _ = make(FakeWeb())
        self.assertIn("nicht erreichbar", offline.command("Zeig mir die ISS"))

    def test_markets_question(self):
        world, _, _ = make()
        self.assertTrue(world.command("Wie steht der DAX?").startswith("Der DAX steht bei 25.231 Punkten"))

    def test_layers_and_zoom(self):
        world, ui, _ = make(active=True)
        self.assertEqual(world.command("Flugverkehr an"), "Flugverkehr eingeblendet, Sir.")
        self.assertEqual(world.command("Zeig mir die Flugzeuge"), "Flugverkehr eingeblendet, Sir.")
        self.assertEqual(world.command("Flugverkehr aus"), "Flugverkehr ausgeblendet, Sir.")
        world.command("Zoom rein")
        world.command("Weiter weg")
        zooms = [e[1]["factor"] for e in ui.of("world") if e[1]["action"] == "view"]
        self.assertLess(zooms[0], 1)
        self.assertGreater(zooms[1], 1)

    def test_hands(self):
        world, ui, _ = make()
        self.assertEqual(world.command("Jarvis, starte die Handsteuerung"), "Sehr wohl, Sir. Handsteuerung aktiv.")
        self.assertTrue(world.active, "ohne andere Ansicht geht die Erde auf")
        self.assertEqual(ui.of("world")[-1][1], {"action": "hands", "on": True})
        self.assertEqual(world.command("Handsteuerung aus"), "Handsteuerung aus, Sir.")
        self.assertEqual(ui.of("world")[-1][1], {"action": "hands", "on": False})
        other, ui2, _ = make()
        other.command("Starte die Handsteuerung", elsewhere=True)
        self.assertFalse(other.active, "ist die Blaupause offen, steuern die Hände dort")
        self.assertEqual(self.actions(ui2), ["hands"])


    def test_look_hologram_or_satellite(self):
        world, ui, _ = make()
        self.assertIsNone(world.command("Hologramm"), "allein und ohne offene Erde: das ist die Blaupause")
        self.assertEqual(world.command("Zeig die Erde als Hologramm"), "Hologramm-Ansicht, Sir.")
        self.assertTrue(world.active, "die Erde geht dafür auf")
        self.assertEqual(self.actions(ui), ["open", "look"])
        self.assertEqual(ui.of("world")[-1][1], {"action": "look", "mode": "holo"})
        self.assertEqual(world.state()["look"], "holo", "Jarvis merkt sich die Ansicht fürs Fenster")
        for text, mode in [("Satellitenbild", "satellit"), ("Hologramm", "holo"), ("Hologramm aus", "satellit"),
                           ("Mach die Erde zum Hologramm", "holo"), ("Zeig mir das Satellitenbild", "satellit"),
                           ("Hologramm-Modus", "holo"), ("Echte Erde", "satellit"), ("Zeig die Welt als Hologramm", "holo")]:
            self.assertIn(", Sir.", world.command(text), text)
            self.assertEqual(world.look, mode, text)
        self.assertEqual(world.command("Hologramm-Modus aus"), "Satellitenbild, Sir.")
        busy, ui2, _ = make(active=True)
        self.assertIsNone(busy.command("Hologramm", elsewhere=True), "ist die Blaupause offen, schaltet sie um")
        self.assertEqual(ui2.of("world"), [])
        self.assertEqual(busy.command("Zeig die Erde als Hologramm", elsewhere=True), "Hologramm-Ansicht, Sir.",
                         "mit Erde im Satz ist klar, was gemeint ist")


class BriefingTest(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(weltlage, "PAUSE_BETWEEN", 0.0)
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_briefing(self, world, kind="welt"):
        with mock.patch.object(weltlage.time, "sleep"):
            answer = world.briefing(kind)
            wait_for(lambda: not world.busy)
        return answer

    def test_flies_and_reads_every_item(self):
        world, ui, voice = make()
        with mock.patch.object(world._skip, "wait", return_value=False):
            answer = self.run_briefing(world)
        self.assertEqual(answer, "Lagebericht, Sir.")
        wait_for(lambda: any(e[1]["action"] == "markets" for e in ui.of("world")))
        actions = [e[1]["action"] for e in ui.of("world")]
        self.assertEqual(actions[:3], ["open", "loading", "news"])
        focus = [e[1]["index"] for e in ui.of("world") if e[1]["action"] == "focus"]
        self.assertEqual(focus, [0, 1, 2, 3, 4])
        self.assertEqual(voice.said[0], "Russland greift wichtige Brücke in Kiew an.")
        self.assertEqual(voice.said[-1], "Das war die Lage, Sir.")
        self.assertIn("done", actions)

    def test_offline(self):
        world, ui, voice = make(FakeWeb())
        self.run_briefing(world)
        self.assertEqual(voice.said, ["Die Nachrichten erreiche ich gerade nicht, Sir."])
        news = [e[1] for e in ui.of("world") if e[1]["action"] == "news"]
        self.assertEqual(news[-1]["items"], [])

    def test_stop_and_other_questions_end_it(self):
        world, ui, voice = make()
        voice.gate.clear()  # Jarvis "spricht" noch
        with mock.patch.object(weltlage.time, "sleep"):
            world.briefing("welt")
            wait_for(lambda: any(e[1]["action"] == "news" for e in ui.of("world")))
            self.assertTrue(world.busy)
            self.assertIsNone(world.command("Wie spät ist es?"), "die Frage geht normal weiter ...")
            self.assertFalse(world.busy, "... und der Lagebericht hört auf")
            voice.gate.set()
            time.sleep(0.3)
        self.assertNotIn("Das war die Lage, Sir.", voice.said)

    def test_next_skips_and_hushes(self):
        world, ui, voice = make()
        voice.gate.clear()
        with mock.patch.object(weltlage.time, "sleep"):
            world.briefing("welt")
            wait_for(lambda: voice.said)  # die erste Meldung läuft
            self.assertEqual(world.command("Weiter"), "")
            self.assertEqual(voice.hushed, 1, "der Satz hört sofort auf")
            wait_for(lambda: [e[1]["index"] for e in ui.of("world") if e[1]["action"] == "focus"][-1] == 1)
            world.cancel()
            voice.gate.set()

    def test_tap_on_an_item(self):
        world, ui, voice = make()
        world.items = weltlage.fetch_news("welt", web())
        world.focus(2)
        self.assertEqual(ui.of("world")[-1][1], {"action": "focus", "index": 2})
        self.assertEqual(voice.said, [world.items[2]["sprechen"]])
        world.focus(99)
        self.assertEqual(len(voice.said), 1)

    def test_new_briefing_replaces_old(self):
        world, ui, voice = make()
        voice.gate.clear()
        with mock.patch.object(weltlage.time, "sleep"):
            world.briefing("welt")
            wait_for(lambda: voice.said)
            world.briefing("deutschland")
            voice.gate.set()
            wait_for(lambda: "Das war die Lage, Sir." in voice.said, timeout=8)
        news = [e[1]["kind"] for e in ui.of("world") if e[1]["action"] == "news"]
        self.assertEqual(news[-1], "deutschland")
        self.assertEqual(voice.said.count("Das war die Lage, Sir."), 1)


class FlightsTest(unittest.TestCase):
    def test_box_cache_and_pause(self):
        opener = web()
        world, _, _ = make(opener)
        self.assertIn("näher heran", world.flights([0, 0, 60, 100])["error"])
        first = world.flights([47, 5, 55, 15])
        self.assertEqual((len(first["planes"]), first["error"]), (1, ""))
        calls = len(opener.calls)
        self.assertEqual(world.flights([47.2, 5.1, 55.2, 15.1])["planes"], first["planes"])
        self.assertEqual(len(opener.calls), calls, "gleicher Ausschnitt: aus dem Zwischenspeicher")
        busy = web(**{weltlage.FLIGHTS_API: urllib.error.HTTPError(weltlage.FLIGHTS_API, 429, "Too Many", {}, None)})
        tired, _, _ = make(busy)
        self.assertIn("Pause", tired.flights([47, 5, 55, 15])["error"])
        self.assertIn("Pause", tired.flights([40, 0, 48, 10])["error"])
        self.assertEqual(len([c for c in busy.calls if c.startswith(weltlage.FLIGHTS_API)]), 1, "in der Pause nicht fragen")
        self.assertEqual(world.flights("quatsch")["error"], "Ausschnitt fehlt")


class HandoffTest(unittest.TestCase):
    """Das Gehirn zeigt Orte ("Wo liegt Bhutan?") und startet Lageberichte über jarvis.tool."""

    def test_place_and_briefing(self):
        from tempfile import TemporaryDirectory

        with TemporaryDirectory() as folder:
            world, ui, _ = make()
            self.assertFalse(world.take_handoff(folder), "nichts übergeben")
            weltlage.hand_over(folder, where="Tokio")
            self.assertTrue(world.take_handoff(folder))
            wait_for(lambda: any(e[1]["action"] == "fly" for e in ui.of("world")))
            self.assertEqual([e[1]["ort"]["name"] for e in ui.of("world") if e[1]["action"] == "fly"], ["Tokio"])
            self.assertTrue(world.active)
            self.assertFalse(world.take_handoff(folder), "nur einmal")
            weltlage.hand_over(folder, kind="deutschland")
            with mock.patch.object(world, "briefing") as brief:
                self.assertTrue(world.take_handoff(folder))
            brief.assert_called_once_with("deutschland")
            path = weltlage.hand_over(folder, where="Paris")
            data = json.loads(path.read_text(encoding="utf-8"))
            data["zeit"] = "2020-01-01T00:00:00"
            path.write_text(json.dumps(data), encoding="utf-8")
            self.assertFalse(world.take_handoff(folder), "zu alt")

    def test_tool_command(self):
        from tempfile import TemporaryDirectory

        from jarvis import tool

        with TemporaryDirectory() as folder, mock.patch.object(tool, "STATE_DIR", Path(folder)), \
                mock.patch("builtins.print") as printed:
            self.assertEqual(tool.main(["weltlage", "Bhutan"]), 0)
            self.assertIn("Die Erde fliegt hin", printed.call_args.args[0])
            data = json.loads((Path(folder) / weltlage.HANDOFF).read_text(encoding="utf-8"))
            self.assertEqual(data["ort"], "Bhutan")
            self.assertEqual(tool.main(["weltlage-bericht", "deutschland"]), 0)
            self.assertEqual(json.loads((Path(folder) / weltlage.HANDOFF).read_text(encoding="utf-8"))["lage"], "deutschland")
            self.assertEqual(tool.main(["weltlage-bericht", "mond"]), 1)
            self.assertEqual(tool.main(["weltlage"]), 1)


class AssistantTest(unittest.TestCase):
    def test_routing_stop_and_window(self):
        from tests.test_assistant import FakeBrain, make as make_assistant

        assistant, ui, speaker, _ = make_assistant(FakeBrain())
        world = Weltlage({}, ui, assistant.say, speaker.wait, hush=speaker.stop, opener=web())
        assistant.world = world
        with mock.patch.object(world, "_brief"):
            self.assertEqual(assistant.handle("Zeig mir, was in der Welt passiert"), "Lagebericht, Sir.")
        self.assertIn("Lagebericht, Sir.", speaker.said)
        self.assertEqual(assistant.handle("Flieg nach Tokio"), "Kurs auf Tokio, Sir.")
        world._running = True
        assistant.stop()
        self.assertFalse(world.busy, "Stopp hält auch den Lagebericht an")

    def test_window_api(self):
        from jarvis.gui.app import Api

        world, ui, voice = make()
        api = Api.__new__(Api)
        api._assistant = mock.Mock(_cfg={"weltlage": {"handsteuerung": False}}, world=world)
        api._bridge = mock.Mock()
        state = api.weltlage_state()
        self.assertFalse(state["hands_allowed"])
        self.assertTrue(api.weltlage_active(True))
        self.assertTrue(world.active)
        with mock.patch.object(weltlage, "geocode", return_value=orte.lookup("Paris")):
            self.assertEqual(api.weltlage_fly("Paris")["ort"]["name"], "Paris")
        with mock.patch.object(weltlage, "geocode", return_value=None):
            self.assertFalse(api.weltlage_fly("Atlantis")["ok"])
        self.assertFalse(api.weltlage_fly("")["ok"])
        self.assertEqual(api.weltlage_flights([47, 5, 55, 15])["planes"][0]["ruf"], "DLH4AB")
        self.assertEqual(api.weltlage_look("holo"), "holo")
        self.assertEqual(api.weltlage_state()["look"], "holo", "Knopf im Fenster und Sprache kennen dieselbe Ansicht")
        self.assertEqual(api.weltlage_look("irgendwas"), "satellit")
        api._assistant = mock.Mock(_cfg={}, world=None)
        self.assertIsNone(api.weltlage_state())
        self.assertEqual(api.weltlage_markets(), [])
        self.assertEqual(api.weltlage_look("holo"), "")


if __name__ == "__main__":
    unittest.main()
