"""Supermärkte in der Nähe (OpenStreetMap/Overpass): auslesen, sortieren, zwischenspeichern, ohne Netz nichts."""

import unittest

import tests.helpers  # noqa: F401
from jarvis.naehe import Nearby, distance, parse, spoken_distance, walk_minutes

HERE = (52.5200, 13.4050)
ANSWER = {"elements": [
    {"type": "way", "id": 7, "center": {"lat": 52.5227, "lon": 13.4050},
     "tags": {"shop": "supermarket", "name": "Rewe", "addr:street": "Hauptstraße", "addr:housenumber": "5"}},
    {"type": "node", "id": 8, "lat": 52.5205, "lon": 13.4050, "tags": {"shop": "supermarket", "brand": "Lidl"}},
    {"type": "node", "id": 9, "lat": 52.5210, "lon": 13.4050, "tags": {"shop": "supermarket"}},  # ohne Namen
    {"type": "node", "id": 10, "tags": {"name": "kaputt"}},
    "Unsinn",
]}


class NearbyTest(unittest.TestCase):
    def test_parse_sorts_and_skips_nameless(self):
        shops = parse(ANSWER, *HERE)
        self.assertEqual([s["name"] for s in shops], ["Lidl", "Rewe"])
        self.assertEqual(shops[1]["adresse"], "Hauptstraße 5")
        self.assertEqual(shops[1]["id"], "way/7")
        self.assertAlmostEqual(shops[1]["meter"], 300, delta=5)

    def test_words(self):
        self.assertAlmostEqual(distance(52.52, 13.405, 52.53, 13.405), 1112, delta=3)
        self.assertEqual(spoken_distance(296), "300 Meter")
        self.assertEqual(spoken_distance(4), "10 Meter")
        self.assertEqual(spoken_distance(1530), "1,5 Kilometer")
        self.assertEqual(spoken_distance(2000), "2 Kilometer")
        self.assertEqual(walk_minutes(300), 4)
        self.assertEqual(walk_minutes(10), 1)

    def test_cache_and_rounded_position(self):
        queries = []

        def fetch(url, query, timeout):
            queries.append(query)
            return ANSWER

        nearby = Nearby(fetch=fetch)
        self.assertEqual(nearby.nearest(*HERE)["name"], "Lidl")
        self.assertEqual(nearby.nearest(HERE[0] + 0.0002, HERE[1])["name"], "Lidl", "20 m weiter: aus dem Speicher")
        self.assertEqual(len(queries), 1)
        self.assertIn("around:1500,52.5200,13.4050", queries[0], "nur auf etwa 10 m genau")
        nearby.nearest(48.137, 11.575)
        self.assertEqual(len(queries), 2)

    def test_cache_measures_from_the_new_place(self):
        both = {"elements": [
            {"type": "node", "id": 1, "lat": 52.5212, "lon": 13.4050, "tags": {"name": "Nord"}},
            {"type": "node", "id": 2, "lat": 52.5188, "lon": 13.4050, "tags": {"name": "Süd"}},
        ]}
        nearby = Nearby(fetch=lambda url, query, timeout: both)
        self.assertEqual(nearby.nearest(52.5208, 13.4050)["name"], "Nord")
        shops = nearby.supermarkets(52.5192, 13.4050)  # gleiches Feld im Speicher, aber jetzt im Süden
        self.assertEqual([s["name"] for s in shops], ["Süd", "Nord"])
        self.assertEqual(nearby.nearest(52.5192, 13.4050)["name"], "Süd")

    def test_without_network_nothing(self):
        def broken(url, query, timeout):
            raise OSError("kein Netz")

        nearby = Nearby(fetch=broken)
        self.assertEqual(nearby.supermarkets(*HERE), [])
        self.assertIsNone(nearby.nearest(*HERE))


if __name__ == "__main__":
    unittest.main()
