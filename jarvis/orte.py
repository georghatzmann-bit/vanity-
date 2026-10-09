"""Wo eine Nachricht spielt: ein kleines Ortsverzeichnis für die Weltlage (weltlage.py).

Ohne Internet und ohne Claude, darum sofort: Länder (auch "Italiens", "spanische Regierung"), Hauptstädte
und große Städte, deutsche Länder und Städte, dazu Einrichtungen ("Kreml", "Pentagon", "EU") und bekannte
Politiker ("Sánchez" spielt in Spanien). find() nimmt den genauesten Ort: Stadt vor Land vor Region.

Koordinaten in Grad (Breite, Länge), dazu grob die Ausdehnung in km: Daraus wählt die Erde die Flughöhe.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass


@dataclass(frozen=True)
class Ort:
    name: str
    lat: float
    lon: float
    km: float  # grobe Ausdehnung: Stadt 30, kleines Land 300, großes Land 3000

    @property
    def genau(self) -> int:
        """Wie genau: 3 = Stadt oder Gebäude, 2 = Region oder kleines Land, 1 = großes Land, 0 = Kontinent."""
        if self.km <= 80:
            return 3
        if self.km <= 700:
            return 2
        if self.km <= 6000:
            return 1
        return 0

    def as_dict(self) -> dict:
        return {"name": self.name, "lat": self.lat, "lon": self.lon, "km": self.km}


# Länder: Namen (der erste ist der angezeigte), Breite, Länge, Ausdehnung, Adjektiv-Stämme
LAENDER = [
    (("Deutschland", "Bundesrepublik", "BRD"), 51.2, 10.4, 900, ("deutsch",)),
    (("Österreich",), 47.6, 14.1, 550, ("österreichisch",)),
    (("Schweiz",), 46.8, 8.2, 350, ("schweizer", "schweizerisch", "eidgenössisch")),
    (("Frankreich",), 46.6, 2.4, 1000, ("französisch",)),
    (("Spanien",), 40.2, -3.6, 1000, ("spanisch",)),
    (("Portugal",), 39.6, -8.0, 550, ("portugiesisch",)),
    (("Italien",), 42.8, 12.6, 1100, ("italienisch",)),
    (("Großbritannien", "Vereinigtes Königreich", "UK", "Britannien", "England"), 53.0, -1.8, 900,
     ("britisch", "englisch", "brite", "briten")),
    (("Irland",), 53.2, -8.0, 450, ("irisch",)),
    (("Niederlande", "Holland"), 52.2, 5.5, 300, ("niederländisch", "holländisch")),
    (("Belgien",), 50.6, 4.6, 280, ("belgisch",)),
    (("Luxemburg",), 49.8, 6.1, 80, ("luxemburgisch",)),
    (("Dänemark",), 56.0, 10.0, 400, ("dänisch",)),
    (("Schweden",), 62.0, 15.5, 1500, ("schwedisch",)),
    (("Norwegen",), 63.5, 10.5, 1700, ("norwegisch",)),
    (("Finnland",), 63.5, 26.0, 1100, ("finnisch",)),
    (("Island",), 64.9, -18.6, 500, ("isländisch",)),
    (("Polen",), 52.1, 19.4, 700, ("polnisch",)),
    (("Tschechien",), 49.8, 15.5, 450, ("tschechisch",)),
    (("Slowakei",), 48.7, 19.7, 400, ("slowakisch",)),
    (("Ungarn",), 47.2, 19.4, 500, ("ungarisch",)),
    (("Slowenien",), 46.1, 14.8, 250, ("slowenisch",)),
    (("Kroatien",), 45.1, 15.6, 450, ("kroatisch",)),
    (("Serbien",), 44.0, 20.9, 450, ("serbisch",)),
    (("Bosnien",), 44.2, 17.8, 300, ("bosnisch",)),
    (("Montenegro",), 42.7, 19.3, 150, ("montenegrinisch",)),
    (("Albanien",), 41.1, 20.0, 300, ("albanisch",)),
    (("Nordmazedonien", "Mazedonien"), 41.6, 21.7, 220, ("mazedonisch",)),
    (("Kosovo",), 42.6, 20.9, 130, ("kosovarisch",)),
    (("Griechenland",), 39.1, 22.4, 700, ("griechisch",)),
    (("Bulgarien",), 42.7, 25.3, 500, ("bulgarisch",)),
    (("Rumänien",), 45.9, 24.9, 650, ("rumänisch",)),
    (("Moldau", "Moldawien", "Republik Moldau"), 47.2, 28.5, 330, ("moldauisch",)),
    (("Ukraine",), 49.0, 31.4, 1300, ("ukrainisch",)),
    (("Belarus", "Weißrussland"), 53.7, 28.0, 650, ("belarussisch", "weißrussisch")),
    (("Litauen",), 55.3, 23.9, 350, ("litauisch",)),
    (("Lettland",), 56.9, 24.6, 400, ("lettisch",)),
    (("Estland",), 58.6, 25.0, 350, ("estnisch",)),
    (("Russland", "Russische Föderation"), 58.0, 45.0, 5000, ("russisch",)),
    (("Türkei",), 39.0, 35.2, 1500, ("türkisch",)),
    (("Zypern",), 35.0, 33.2, 220, ("zyprisch",)),
    (("Malta",), 35.9, 14.4, 40, ("maltesisch",)),
    (("Georgien",), 42.3, 43.4, 450, ("georgisch",)),
    (("Armenien",), 40.1, 45.0, 300, ("armenisch",)),
    (("Aserbaidschan",), 40.3, 47.7, 450, ("aserbaidschanisch",)),
    (("Kasachstan",), 48.0, 67.0, 2500, ("kasachisch",)),
    (("Israel",), 31.4, 35.0, 300, ("israelisch",)),
    (("Gazastreifen", "Gaza"), 31.42, 34.38, 40, ()),
    (("Westjordanland",), 31.95, 35.25, 120, ()),
    (("Palästina", "Palästinensergebiete"), 31.9, 35.2, 200, ("palästinensisch",)),
    (("Libanon",), 33.9, 35.9, 200, ("libanesisch",)),
    (("Syrien",), 35.0, 38.5, 700, ("syrisch",)),
    (("Jordanien",), 31.2, 36.5, 400, ("jordanisch",)),
    (("Irak",), 33.0, 43.7, 900, ("irakisch",)),
    (("Iran",), 32.5, 54.3, 2000, ("iranisch",)),
    (("Saudi-Arabien", "Saudi Arabien"), 24.0, 45.0, 2000, ("saudisch", "saudi-arabisch")),
    (("Jemen",), 15.6, 48.0, 1000, ("jemenitisch",)),
    (("Oman",), 21.0, 57.0, 900, ("omanisch",)),
    (("Vereinigte Arabische Emirate", "VAE", "Emirate"), 24.0, 54.0, 400, ("emiratisch",)),
    (("Katar",), 25.3, 51.2, 150, ("katarisch",)),
    (("Kuwait",), 29.3, 47.6, 180, ("kuwaitisch",)),
    (("Bahrain",), 26.0, 50.55, 50, ()),
    (("Ägypten",), 26.8, 30.8, 1200, ("ägyptisch",)),
    (("Libyen",), 27.0, 17.0, 1600, ("libysch",)),
    (("Tunesien",), 34.0, 9.5, 600, ("tunesisch",)),
    (("Algerien",), 28.0, 2.6, 2000, ("algerisch",)),
    (("Marokko",), 31.8, -7.1, 900, ("marokkanisch",)),
    (("Sudan",), 15.5, 30.2, 1500, ("sudanesisch",)),
    (("Südsudan",), 7.3, 30.5, 900, ("südsudanesisch",)),
    (("Äthiopien",), 9.1, 40.5, 1200, ("äthiopisch",)),
    (("Somalia",), 5.2, 46.2, 1200, ("somalisch",)),
    (("Kenia",), 0.2, 37.9, 900, ("kenianisch",)),
    (("Tansania",), -6.4, 34.9, 1000, ("tansanisch",)),
    (("Uganda",), 1.4, 32.3, 500, ("ugandisch",)),
    (("Ruanda",), -1.9, 29.9, 180, ("ruandisch",)),
    (("Kongo", "Demokratische Republik Kongo", "DR Kongo"), -2.9, 23.7, 1800, ("kongolesisch",)),
    (("Nigeria",), 9.1, 8.7, 1100, ("nigerianisch",)),
    (("Niger",), 17.6, 8.1, 1300, ()),
    (("Mali",), 17.6, -4.0, 1400, ("malisch",)),
    (("Burkina Faso",), 12.3, -1.6, 600, ()),
    (("Senegal",), 14.5, -14.5, 500, ("senegalesisch",)),
    (("Ghana",), 7.9, -1.0, 600, ("ghanaisch",)),
    (("Elfenbeinküste",), 7.5, -5.5, 600, ("ivorisch",)),
    (("Kamerun",), 7.4, 12.4, 900, ("kamerunisch",)),
    (("Tschad",), 15.5, 18.7, 1300, ("tschadisch",)),
    (("Südafrika",), -30.6, 22.9, 1300, ("südafrikanisch",)),
    (("Namibia",), -22.6, 17.1, 1100, ("namibisch",)),
    (("Simbabwe",), -19.0, 29.2, 700, ("simbabwisch",)),
    (("Mosambik",), -18.7, 35.5, 1300, ("mosambikanisch",)),
    (("Madagaskar",), -19.4, 46.7, 1200, ("madagassisch",)),
    (("Afghanistan",), 33.9, 67.7, 1100, ("afghanisch",)),
    (("Pakistan",), 30.4, 69.3, 1400, ("pakistanisch",)),
    (("Indien",), 22.0, 79.0, 2800, ("indisch",)),
    (("Bangladesch",), 23.7, 90.4, 500, ("bangladeschisch",)),
    (("Sri Lanka",), 7.9, 80.8, 400, ("sri-lankisch",)),
    (("Nepal",), 28.4, 84.1, 700, ("nepalesisch",)),
    (("China", "Volksrepublik China"), 35.0, 104.0, 4000, ("chinesisch",)),
    (("Taiwan",), 23.7, 121.0, 350, ("taiwanisch",)),
    (("Hongkong", "Hong Kong"), 22.32, 114.17, 50, ()),
    (("Mongolei",), 46.9, 103.8, 2000, ("mongolisch",)),
    (("Nordkorea",), 40.3, 127.5, 500, ("nordkoreanisch",)),
    (("Südkorea", "Korea"), 36.4, 127.9, 450, ("südkoreanisch", "koreanisch")),
    (("Japan",), 36.2, 138.3, 1600, ("japanisch",)),
    (("Vietnam",), 16.0, 107.8, 1300, ("vietnamesisch",)),
    (("Thailand",), 15.3, 101.0, 1100, ("thailändisch",)),
    (("Myanmar", "Birma", "Burma"), 21.0, 96.0, 1300, ("myanmarisch", "birmanisch")),
    (("Kambodscha",), 12.6, 104.9, 450, ("kambodschanisch",)),
    (("Malaysia",), 3.9, 102.0, 1300, ("malaysisch",)),
    (("Singapur",), 1.35, 103.82, 40, ("singapurisch",)),
    (("Indonesien",), -2.5, 118.0, 4000, ("indonesisch",)),
    (("Philippinen",), 12.9, 121.8, 1300, ("philippinisch",)),
    (("Australien",), -25.3, 133.8, 3500, ("australisch",)),
    (("Neuseeland",), -41.3, 174.0, 1200, ("neuseeländisch",)),
    (("USA", "Vereinigte Staaten", "US", "Amerika"), 39.5, -98.4, 4000, ("amerikanisch", "us-amerikanisch")),
    (("Kanada",), 56.1, -106.3, 4500, ("kanadisch",)),
    (("Grönland",), 72.0, -40.0, 2200, ("grönländisch",)),
    (("Mexiko",), 23.6, -102.5, 2500, ("mexikanisch",)),
    (("Kuba",), 21.5, -79.5, 900, ("kubanisch",)),
    (("Haiti",), 19.0, -72.4, 250, ("haitianisch",)),
    (("Venezuela",), 7.0, -66.0, 1200, ("venezolanisch",)),
    (("Kolumbien",), 4.6, -74.1, 1300, ("kolumbianisch",)),
    (("Ecuador",), -1.8, -78.2, 600, ("ecuadorianisch",)),
    (("Peru",), -9.2, -75.0, 1500, ("peruanisch",)),
    (("Bolivien",), -16.3, -63.6, 1200, ("bolivianisch",)),
    (("Brasilien",), -14.2, -51.9, 3800, ("brasilianisch",)),
    (("Chile",), -33.0, -71.0, 2500, ("chilenisch",)),
    (("Argentinien",), -38.4, -63.6, 2500, ("argentinisch",)),
    (("Uruguay",), -32.5, -55.8, 450, ("uruguayisch",)),
    (("Paraguay",), -23.4, -58.4, 700, ("paraguayisch",)),
    (("Europa",), 50.0, 12.0, 4000, ("europäisch",)),
    (("Afrika",), 2.0, 20.0, 7000, ("afrikanisch",)),
    (("Asien",), 34.0, 95.0, 8000, ("asiatisch",)),
    (("Nahost", "Naher Osten", "Nahen Osten"), 31.5, 37.0, 1500, ("nahöstlich",)),
    (("Arktis",), 80.0, 0.0, 3000, ("arktisch",)),
    (("Antarktis",), -80.0, 0.0, 4000, ("antarktisch",)),
]

# Städte, Regionen und Orte (Namen, Breite, Länge, Ausdehnung)
STAEDTE = [
    # Deutschland: Länder
    (("Bayern",), 48.95, 11.4, 300), (("Baden-Württemberg",), 48.55, 9.0, 230), (("Hessen",), 50.6, 9.0, 200),
    (("Nordrhein-Westfalen", "NRW"), 51.45, 7.6, 230), (("Niedersachsen",), 52.6, 9.4, 300),
    (("Schleswig-Holstein",), 54.2, 9.8, 180), (("Mecklenburg-Vorpommern",), 53.7, 12.6, 220),
    (("Brandenburg",), 52.4, 13.2, 230), (("Sachsen-Anhalt",), 51.95, 11.7, 200), (("Sachsen",), 51.05, 13.3, 200),
    (("Thüringen",), 50.9, 11.0, 180), (("Rheinland-Pfalz",), 49.9, 7.4, 180), (("Saarland",), 49.4, 6.95, 70),
    (("Ruhrgebiet",), 51.48, 7.2, 80), (("Nordsee",), 55.5, 3.5, 700), (("Ostsee",), 57.0, 19.0, 900),
    (("Alpen",), 46.6, 10.5, 800), (("Bodensee",), 47.6, 9.4, 60), (("Rhein",), 50.3, 7.6, 400),
    # Deutschland: Städte
    (("Berlin", "Bundestag", "Bundesregierung", "Kanzleramt", "Bundeskanzler", "Bundesrat"), 52.52, 13.405, 35),
    (("Hamburg",), 53.55, 9.99, 35), (("München",), 48.137, 11.575, 25), (("Köln",), 50.94, 6.96, 25),
    (("Frankfurt", "Frankfurt am Main", "EZB", "Europäische Zentralbank"), 50.11, 8.68, 20),
    (("Stuttgart",), 48.78, 9.18, 20), (("Düsseldorf",), 51.23, 6.78, 20), (("Leipzig",), 51.34, 12.37, 20),
    (("Dortmund",), 51.51, 7.47, 20), (("Essen",), 51.46, 7.01, 20), (("Bremen",), 53.08, 8.80, 20),
    (("Dresden",), 51.05, 13.74, 20), (("Hannover",), 52.37, 9.73, 20), (("Nürnberg",), 49.45, 11.08, 20),
    (("Duisburg",), 51.43, 6.76, 18), (("Bochum",), 51.48, 7.22, 15), (("Wuppertal",), 51.26, 7.15, 15),
    (("Bielefeld",), 52.02, 8.53, 15), (("Bonn",), 50.74, 7.10, 15), (("Münster",), 51.96, 7.63, 15),
    (("Karlsruhe", "Bundesverfassungsgericht", "Bundesgerichtshof"), 49.01, 8.40, 15),
    (("Mannheim",), 49.49, 8.47, 15), (("Augsburg",), 48.37, 10.90, 15), (("Wiesbaden",), 50.08, 8.24, 15),
    (("Mainz",), 49.99, 8.25, 12), (("Kiel",), 54.32, 10.13, 15), (("Rostock",), 54.09, 12.10, 15),
    (("Magdeburg",), 52.12, 11.63, 15), (("Erfurt",), 50.98, 11.03, 15), (("Potsdam",), 52.39, 13.06, 15),
    (("Schwerin",), 53.63, 11.41, 12), (("Saarbrücken",), 49.24, 6.99, 12), (("Freiburg",), 47.99, 7.85, 12),
    (("Heidelberg",), 49.40, 8.67, 10), (("Regensburg",), 49.01, 12.10, 10), (("Würzburg",), 49.79, 9.95, 10),
    (("Ingolstadt",), 48.77, 11.42, 10), (("Wolfsburg",), 52.42, 10.79, 10), (("Braunschweig",), 52.27, 10.52, 12),
    (("Chemnitz",), 50.83, 12.92, 12), (("Halle",), 51.48, 11.97, 12), (("Lübeck",), 53.87, 10.69, 12),
    (("Aachen",), 50.78, 6.08, 12), (("Kassel",), 51.31, 9.48, 12), (("Göttingen",), 51.54, 9.93, 10),
    (("Ulm",), 48.40, 9.99, 10), (("Sylt",), 54.90, 8.31, 25), (("Rügen",), 54.42, 13.40, 35),
    # Europa
    (("Wien",), 48.21, 16.37, 25), (("Graz",), 47.07, 15.44, 12), (("Salzburg",), 47.81, 13.06, 10),
    (("Innsbruck",), 47.27, 11.39, 10), (("Linz",), 48.31, 14.29, 10),
    (("Zürich",), 47.37, 8.54, 15), (("Bern",), 46.95, 7.45, 10), (("Genf",), 46.20, 6.14, 12),
    (("Basel",), 47.56, 7.59, 10), (("Davos",), 46.80, 9.84, 10),
    (("Paris", "Élysée", "Elysee", "Élysée-Palast"), 48.857, 2.352, 30), (("Marseille",), 43.30, 5.37, 20),
    (("Lyon",), 45.76, 4.84, 15), (("Straßburg", "Europaparlament", "EU-Parlament", "Europäisches Parlament"),
                                    48.58, 7.75, 12),
    (("Nizza",), 43.70, 7.27, 12), (("Bordeaux",), 44.84, -0.58, 12), (("Toulouse",), 43.60, 1.44, 12),
    (("Madrid",), 40.417, -3.704, 30), (("Barcelona", "Katalonien"), 41.39, 2.17, 25), (("Valencia",), 39.47, -0.38, 15),
    (("Sevilla",), 37.39, -5.98, 15), (("Mallorca", "Palma"), 39.60, 2.95, 60), (("Ibiza",), 38.98, 1.43, 30),
    (("Kanaren", "Kanarische Inseln", "Teneriffa", "Gran Canaria"), 28.3, -16.0, 300),
    (("Lissabon",), 38.72, -9.14, 20), (("Porto",), 41.15, -8.61, 15), (("Madeira",), 32.75, -16.95, 50),
    (("Rom", "Vatikan", "Papst", "Petersdom"), 41.90, 12.48, 25), (("Mailand",), 45.46, 9.19, 20),
    (("Neapel",), 40.85, 14.27, 15), (("Venedig",), 45.44, 12.33, 12), (("Florenz",), 43.77, 11.26, 12),
    (("Turin",), 45.07, 7.69, 15), (("Sizilien", "Palermo"), 37.6, 14.0, 250), (("Sardinien",), 40.1, 9.0, 250),
    (("Lampedusa",), 35.51, 12.60, 15),
    (("London", "Downing Street", "Westminster", "Buckingham"), 51.507, -0.128, 40),
    (("Manchester",), 53.48, -2.24, 20), (("Liverpool",), 53.41, -2.98, 15), (("Birmingham",), 52.49, -1.89, 20),
    (("Edinburgh",), 55.95, -3.19, 15), (("Schottland",), 56.8, -4.2, 350), (("Wales",), 52.3, -3.7, 200),
    (("Nordirland", "Belfast"), 54.6, -6.7, 150), (("Dublin",), 53.35, -6.26, 20),
    (("Amsterdam",), 52.37, 4.90, 20), (("Rotterdam",), 51.92, 4.48, 15), (("Den Haag", "Internationaler Strafgerichtshof"),
                                                                              52.08, 4.30, 12),
    (("Brüssel", "EU", "Europäische Union", "EU-Kommission", "Nato", "NATO", "Europäischer Rat"), 50.85, 4.35, 20),
    (("Antwerpen",), 51.22, 4.40, 12), (("Kopenhagen",), 55.68, 12.57, 20), (("Stockholm",), 59.33, 18.07, 20),
    (("Oslo",), 59.91, 10.75, 20), (("Helsinki",), 60.17, 24.94, 20), (("Reykjavík", "Reykjavik"), 64.15, -21.94, 15),
    (("Warschau",), 52.23, 21.01, 25), (("Krakau",), 50.06, 19.94, 15), (("Danzig",), 54.35, 18.65, 15),
    (("Prag",), 50.08, 14.44, 20), (("Bratislava", "Pressburg"), 48.15, 17.11, 15), (("Budapest",), 47.50, 19.04, 25),
    (("Ljubljana",), 46.06, 14.51, 12), (("Zagreb",), 45.81, 15.98, 15), (("Belgrad",), 44.79, 20.45, 20),
    (("Sarajevo",), 43.86, 18.41, 12), (("Pristina",), 42.66, 21.17, 10), (("Tirana",), 41.33, 19.82, 12),
    (("Athen",), 37.98, 23.73, 25), (("Thessaloniki",), 40.64, 22.94, 15), (("Kreta",), 35.24, 24.9, 150),
    (("Rhodos",), 36.2, 28.0, 50), (("Lesbos",), 39.2, 26.3, 50), (("Sofia",), 42.70, 23.32, 20),
    (("Bukarest",), 44.43, 26.10, 20), (("Chișinău", "Chisinau"), 47.01, 28.86, 12),
    (("Kiew", "Kyjiw", "Kiev"), 50.45, 30.52, 30), (("Charkiw", "Charkow"), 49.99, 36.23, 20),
    (("Odessa",), 46.48, 30.73, 20), (("Lwiw", "Lemberg"), 49.84, 24.03, 15), (("Dnipro",), 48.46, 35.05, 15),
    (("Saporischschja",), 47.84, 35.14, 15), (("Cherson",), 46.64, 32.62, 15), (("Mariupol",), 47.10, 37.55, 15),
    (("Donezk", "Donbass", "Donbas"), 48.0, 37.8, 150), (("Luhansk",), 48.57, 39.31, 100), (("Krim",), 45.3, 34.4, 200),
    (("Sewastopol",), 44.62, 33.52, 15), (("Charkiw-Region",), 49.6, 36.6, 150),
    (("Minsk",), 53.90, 27.56, 20), (("Vilnius", "Wilna"), 54.69, 25.28, 15), (("Riga",), 56.95, 24.11, 15),
    (("Tallinn",), 59.44, 24.75, 15), (("Kaliningrad", "Königsberg"), 54.71, 20.51, 15),
    (("Moskau", "Kreml"), 55.755, 37.617, 35), (("Sankt Petersburg", "St. Petersburg", "Petersburg"), 59.94, 30.31, 25),
    (("Sibirien",), 60.0, 100.0, 3500), (("Tschetschenien", "Grosny"), 43.3, 45.7, 80),
    (("Istanbul",), 41.01, 28.98, 35), (("Ankara",), 39.93, 32.86, 20), (("Antalya",), 36.90, 30.70, 15),
    (("Tiflis", "Tbilissi"), 41.72, 44.79, 15), (("Jerewan",), 40.18, 44.51, 15), (("Baku",), 40.41, 49.87, 15),
    (("Bergkarabach", "Berg-Karabach"), 39.8, 46.7, 60),
    # Naher Osten und Afrika
    (("Jerusalem", "Knesset"), 31.78, 35.22, 15), (("Tel Aviv",), 32.08, 34.78, 15), (("Haifa",), 32.79, 34.99, 12),
    (("Gaza-Stadt", "Rafah", "Chan Junis"), 31.4, 34.35, 25), (("Ramallah",), 31.90, 35.20, 10),
    (("Golanhöhen", "Golan"), 33.0, 35.75, 40), (("Beirut",), 33.89, 35.50, 15), (("Damaskus",), 33.51, 36.29, 20),
    (("Aleppo",), 36.20, 37.13, 20), (("Amman",), 31.95, 35.93, 20), (("Bagdad",), 33.31, 44.36, 25),
    (("Teheran",), 35.69, 51.39, 30), (("Riad",), 24.71, 46.68, 25), (("Dschidda", "Jeddah"), 21.49, 39.19, 20),
    (("Mekka",), 21.39, 39.86, 15), (("Dubai",), 25.20, 55.27, 25), (("Abu Dhabi",), 24.45, 54.38, 20),
    (("Doha",), 25.29, 51.53, 15), (("Maskat",), 23.59, 58.41, 15), (("Sanaa",), 15.37, 44.19, 15),
    (("Rotes Meer",), 20.0, 38.5, 1200), (("Suezkanal", "Suez"), 30.6, 32.3, 80), (("Straße von Hormus", "Hormus"), 26.6, 56.3, 120),
    (("Kairo",), 30.04, 31.24, 30), (("Alexandria",), 31.20, 29.92, 20), (("Tripolis",), 32.89, 13.19, 15),
    (("Tunis",), 36.81, 10.18, 15), (("Algier",), 36.75, 3.06, 15), (("Rabat",), 34.02, -6.84, 15),
    (("Casablanca",), 33.57, -7.59, 20), (("Marrakesch",), 31.63, -8.01, 15), (("Khartum",), 15.50, 32.56, 20),
    (("Darfur",), 13.5, 24.5, 500), (("Addis Abeba",), 9.03, 38.74, 20), (("Mogadischu",), 2.05, 45.32, 15),
    (("Nairobi",), -1.29, 36.82, 20), (("Kampala",), 0.35, 32.58, 15), (("Kigali",), -1.95, 30.06, 12),
    (("Kinshasa",), -4.44, 15.27, 25), (("Goma",), -1.68, 29.23, 12), (("Lagos",), 6.52, 3.38, 30),
    (("Abuja",), 9.08, 7.40, 20), (("Accra",), 5.60, -0.19, 15), (("Dakar",), 14.72, -17.47, 15),
    (("Bamako",), 12.64, -8.00, 15), (("Niamey",), 13.51, 2.11, 12), (("Johannesburg",), -26.20, 28.05, 25),
    (("Kapstadt",), -33.92, 18.42, 25), (("Pretoria",), -25.75, 28.19, 15), (("Windhuk",), -22.56, 17.08, 12),
    # Asien und Ozeanien
    (("Kabul",), 34.56, 69.21, 20), (("Islamabad",), 33.68, 73.05, 15), (("Karachi", "Karatschi"), 24.86, 67.01, 25),
    (("Neu-Delhi", "Delhi"), 28.61, 77.21, 30), (("Mumbai", "Bombay"), 19.08, 72.88, 30),
    (("Kalkutta", "Kolkata"), 22.57, 88.36, 25), (("Bangalore", "Bengaluru"), 12.97, 77.59, 25),
    (("Kaschmir",), 34.1, 75.0, 250), (("Dhaka",), 23.81, 90.41, 20), (("Kathmandu",), 27.72, 85.32, 12),
    (("Peking", "Beijing"), 39.90, 116.40, 35), (("Shanghai", "Schanghai"), 31.23, 121.47, 35),
    (("Shenzhen",), 22.54, 114.06, 25), (("Wuhan",), 30.59, 114.31, 25), (("Tibet",), 31.0, 88.0, 1000),
    (("Xinjiang",), 41.0, 85.0, 1500), (("Taipeh", "Taipei"), 25.03, 121.57, 20), (("Macau",), 22.20, 113.54, 10),
    (("Tokio", "Tokyo"), 35.68, 139.69, 40), (("Osaka",), 34.69, 135.50, 25), (("Kyoto",), 35.01, 135.77, 15),
    (("Hiroshima",), 34.39, 132.46, 15), (("Fukushima",), 37.75, 140.47, 30), (("Okinawa",), 26.5, 128.0, 100),
    (("Seoul",), 37.57, 126.98, 30), (("Pjöngjang", "Pyongyang"), 39.04, 125.76, 20), (("Hanoi",), 21.03, 105.85, 20),
    (("Ho-Chi-Minh-Stadt", "Saigon"), 10.82, 106.63, 25), (("Bangkok",), 13.76, 100.50, 30),
    (("Phnom Penh",), 11.56, 104.93, 15), (("Kuala Lumpur",), 3.14, 101.69, 20), (("Jakarta",), -6.21, 106.85, 30),
    (("Bali",), -8.4, 115.2, 80), (("Manila",), 14.60, 120.98, 25), (("Südchinesisches Meer",), 13.0, 114.0, 1500),
    (("Sydney",), -33.87, 151.21, 30), (("Melbourne",), -37.81, 144.96, 30), (("Canberra",), -35.28, 149.13, 15),
    (("Brisbane",), -27.47, 153.03, 20), (("Perth",), -31.95, 115.86, 20), (("Auckland",), -36.85, 174.76, 20),
    (("Wellington",), -41.29, 174.78, 15),
    # Amerika
    (("Washington", "Weißes Haus", "Weißen Haus", "Pentagon", "Kongress", "US-Kongress", "Kapitol", "Senat",
      "US-Senat", "Repräsentantenhaus"), 38.897, -77.036, 25),
    (("New York", "Wall Street", "UN", "UNO", "Vereinte Nationen", "Vereinten Nationen", "UN-Sicherheitsrat"),
     40.713, -74.006, 35),
    (("Los Angeles", "Hollywood"), 34.05, -118.24, 40), (("San Francisco", "Silicon Valley"), 37.77, -122.42, 30),
    (("Chicago",), 41.88, -87.63, 30), (("Miami",), 25.76, -80.19, 25), (("Florida",), 27.8, -81.7, 500),
    (("Kalifornien",), 37.2, -119.4, 800), (("Texas", "Houston"), 31.0, -99.0, 1000), (("Las Vegas",), 36.17, -115.14, 20),
    (("Boston",), 42.36, -71.06, 20), (("Seattle",), 47.61, -122.33, 20), (("Atlanta",), 33.75, -84.39, 20),
    (("Detroit",), 42.33, -83.05, 20), (("Alaska",), 64.2, -152.5, 1500), (("Hawaii",), 20.8, -156.3, 400),
    (("Cape Canaveral", "Kennedy Space Center"), 28.39, -80.60, 20),
    (("Ottawa",), 45.42, -75.70, 15), (("Toronto",), 43.65, -79.38, 25), (("Montreal",), 45.50, -73.57, 20),
    (("Vancouver",), 49.28, -123.12, 20), (("Mexiko-Stadt",), 19.43, -99.13, 35), (("Havanna",), 23.11, -82.37, 20),
    (("Caracas",), 10.48, -66.90, 20), (("Bogotá", "Bogota"), 4.71, -74.07, 25), (("Lima",), -12.05, -77.04, 25),
    (("Quito",), -0.18, -78.47, 15), (("La Paz",), -16.49, -68.12, 15), (("Santiago de Chile", "Santiago"), -33.45, -70.67, 25),
    (("Buenos Aires",), -34.60, -58.38, 30), (("Montevideo",), -34.90, -56.16, 15), (("Brasília", "Brasilia"), -15.79, -47.88, 20),
    (("Rio de Janeiro", "Rio"), -22.91, -43.17, 25), (("São Paulo", "Sao Paulo"), -23.55, -46.63, 35),
    (("Amazonas", "Amazonien", "Regenwald"), -4.0, -62.0, 2000), (("Panama", "Panamakanal"), 9.0, -79.5, 300),
    (("Karibik",), 16.0, -72.0, 2000),
]

# Wer wo Politik macht: der Name in einer Schlagzeile verrät den Ort
PERSONEN = {
    "trump": "Washington", "vance": "Washington", "rubio": "Washington", "hegseth": "Washington",
    "biden": "Washington", "putin": "Moskau", "lawrow": "Moskau", "peskow": "Moskau", "medwedew": "Moskau",
    "selenskyj": "Kiew", "macron": "Paris", "starmer": "London", "sánchez": "Madrid", "sanchez": "Madrid",
    "meloni": "Rom", "orbán": "Budapest", "orban": "Budapest", "erdoğan": "Ankara", "erdogan": "Ankara",
    "netanjahu": "Jerusalem", "netanyahu": "Jerusalem", "chamenei": "Teheran", "xi jinping": "Peking",
    "kim jong un": "Pjöngjang", "lula": "Brasília", "milei": "Buenos Aires", "tusk": "Warschau",
    "fico": "Bratislava", "von der leyen": "Brüssel", "merz": "Berlin", "scholz": "Berlin", "steinmeier": "Berlin",
    "pistorius": "Berlin", "klingbeil": "Berlin", "carney": "Ottawa", "sheinbaum": "Mexiko-Stadt", "maduro": "Caracas",
    "lukaschenko": "Minsk", "aliyev": "Baku", "paschinjan": "Jerewan", "guterres": "New York",
    "leo xiv": "Rom", "ishiba": "Tokio", "takaichi": "Tokio", "lee jae-myung": "Seoul",
}

# Besondere Ziele: die Raumstation (die Erde von oben)
WELTRAUM = Ort("Raumstation ISS", 30.0, 10.0, 12000)
_SPACE = re.compile(r"\b(?:iss|raumstation|weltraum|all|orbit|raumfahrt|astronaut\w*)\b")


def _fold(text: str) -> str:
    """Kleinbuchstaben, Bindestriche wie Leerzeichen, Akzente bleiben (Sánchez == Sanchez kommt über PERSONEN)."""
    text = unicodedata.normalize("NFC", str(text or "")).lower()
    return " ".join(re.sub(r"[\"„“”'’«»()\[\]:;,.!?]", " ", text).replace("‑", "-").split())


def _build() -> tuple[dict[str, Ort], re.Pattern, dict[str, Ort], re.Pattern]:
    names: dict[str, Ort] = {}
    adjectives: dict[str, Ort] = {}
    for aliases, lat, lon, km, stems in LAENDER:
        place = Ort(aliases[0], lat, lon, km)
        for alias in aliases:
            names.setdefault(_fold(alias), place)
        for stem in stems:
            adjectives.setdefault(_fold(stem), place)
    for aliases, lat, lon, km in STAEDTE:
        place = Ort(aliases[0], lat, lon, km)
        for alias in aliases:
            names.setdefault(_fold(alias), place)
    for person, city in PERSONEN.items():
        names.setdefault(_fold(person), names[_fold(city)])
    keys = sorted(names, key=len, reverse=True)
    # "Italiens", "Deutschlands", "Kiews": Genitiv mit s; "US-Präsident", "EU-Kommission": vor dem Bindestrich
    pattern = re.compile(r"(?<!\w)(" + "|".join(re.escape(k) for k in keys) + r")(?:s|es)?(?!\w)")
    stems = sorted(adjectives, key=len, reverse=True)
    adjective = re.compile(r"(?<!\w)(" + "|".join(re.escape(s) for s in stems) + r")(?:e|en|er|es|em|n)?(?!\w)")
    return names, pattern, adjectives, adjective


_NAMES, _PATTERN, _ADJECTIVES, _ADJECTIVE = _build()
# Wörter, die auch etwas anderes heißen: "Essen" (Mahlzeit), "Porto" (Briefporto), "rügen" (tadeln), der
# Berliner "Senat", "Kongress" irgendwo ... Die zählen nur mit einem eindeutigen Hinweis daneben.
_RISKY = {
    "essen": r"\b(?:in|aus|nach|bei) essen\b|\bessen (?:hbf|stadt)\b",
    "halle": r"\b(?:in|aus|nach) halle\b|halle \(saale\)|halle an der saale",
    "porto": r"\b(?:in|aus|nach) porto\b|\bfc porto\b",
    "rügen": r"\b(?:auf|insel|nach) rügen\b",
    "un": r"\bun-|\bun (?:sicherheitsrat|generalsekretär|vollversammlung)",
    "kongress": r"\bus-kongress\b|\bkongress in washington\b|amerikanischen kongress",
    "senat": r"\bus-senat\b|amerikanischen senat",
    "rhein": r"\bam rhein\b|\bder rhein\b",
    "kiel": r"\b(?:in|aus|nach) kiel\b|\bkieler\b",
}


def find_all(text: str) -> list[tuple[int, Ort]]:
    """Alle Orte in einem Text, mit der Stelle, an der sie stehen."""
    folded = _fold(text)
    found: list[tuple[int, Ort]] = []
    for match in _PATTERN.finditer(folded):
        word = match.group(1)
        if word in _RISKY and not re.search(_RISKY[word], folded):
            continue
        found.append((match.start(), _NAMES[word]))
    for match in _ADJECTIVE.finditer(folded):
        found.append((match.start(), _ADJECTIVES[match.group(1)]))
    if _SPACE.search(folded) and re.search(r"\b(?:iss|raumstation|orbit)\b", folded):
        found.append((_SPACE.search(folded).start(), WELTRAUM))
    return sorted(found, key=lambda item: item[0])


def find(*texts: str) -> Ort | None:
    """Der beste Ort für eine Meldung: Die Felder kommen nach Gewicht (Überschrift zuerst). Im ersten Feld mit
    einem Ort gewinnt der genaueste (Kiew vor Russland in "Russland greift Brücke in Kiew an")."""
    for text in texts:
        found = find_all(text)
        if found:
            best = max(found, key=lambda item: (item[1].genau, -item[0]))
            return best[1]
    return None


def lookup(name: str) -> Ort | None:
    """Ein Ort genau beim Namen ("Flieg nach Madrid"), auch mit Genitiv und ohne Akzente."""
    folded = _fold(name)
    if not folded:
        return None
    if folded in _NAMES:
        return _NAMES[folded]
    if folded.endswith("s") and folded[:-1] in _NAMES:
        return _NAMES[folded[:-1]]
    plain = unicodedata.normalize("NFKD", folded).encode("ascii", "ignore").decode()
    for key, place in _NAMES.items():
        if unicodedata.normalize("NFKD", key).encode("ascii", "ignore").decode() == plain:
            return place
    found = find_all(folded)
    if len(found) == 1:
        return found[0][1]
    return None
