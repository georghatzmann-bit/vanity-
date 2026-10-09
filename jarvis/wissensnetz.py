"""Das Wissensnetz (wie im Video "AgenticOS"): alles, was Jarvis weiß, als ein Netz.

Knoten sind das Gedächtnis in der Mitte, die Personen, die Projekte der Werkstatt, Recherchen, Notizen, die
letzten Tage im Tagebuch und die letzten Sitzungen. Die Kanten kommen aus zwei Quellen:

- den [[Links]] im Notizbuch (dieselben, die Obsidian als Graph zeigt),
- automatisch: Teilen zwei Projekte, Recherchen oder Notizen seltene Begriffe ("Gaming", "Discord-Bot"),
  verbindet Jarvis sie, ohne dass Georg etwas tun muss. Die Kante merkt sich, warum.

Das Netz wird aus den Dateien gebaut und nur neu gerechnet, wenn sich etwas geändert hat.
"""

from __future__ import annotations

import datetime as dt
import functools
import logging
import math
import re
import threading
import time
from pathlib import Path

log = logging.getLogger(__name__)

FOLDER_ART = {"tagebuch": "tag", "personen": "person", "recherchen": "recherche", "notizen": "notiz"}
ART_ORDER = ("gedaechtnis", "person", "projekt", "recherche", "notiz", "tag", "sitzung")
MAX_NOTES = 500  # Notizbuch-Dateien höchstens (die neuesten)
MAX_DAYS = 21  # Tagebuch: die letzten drei Wochen
MAX_PROJECTS = 60
MAX_SESSIONS = 8
AUTO_PER_NODE = 2  # automatische Verknüpfungen je Knoten höchstens (die stärksten)
TOP_WORDS = 14  # so viele Schlüsselbegriffe beschreiben einen Knoten
REBUILD_SECONDS = 15  # so lange gilt ein gebautes Netz mindestens

LINK = re.compile(r"\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]")
WORD = re.compile(r"[A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß0-9]+(?:-[A-Za-zÄÖÜäöüß0-9]+)*")
MARKER = re.compile(r"<!--.*?-->", re.S)
TOKEN = re.compile(r"\w+")

# Wörter, die nichts über das Thema sagen (Deutsch, dazu Jarvis' eigene Floskeln)
STOP = set("""
aber alle allem allen aller alles also auch auf aus bald beim beide beiden bereits besser bevor bis bisher bitte
bleibt brauchen bringt damit danach dann darauf darin darum dass davon dazu dein deine deinem deinen deiner dem den
denn der deren des dessen dich die dies diese diesem diesen dieser dieses dir doch dort durch eben ebenfalls ein
eine einem einen einer eines einfach einige einmal etwa etwas euch euer eure für ganz gegen gerade gern gibt gleich
gut habe haben hast hat hatte hätte heute hier hin hinter ihm ihn ihnen ihr ihre ihrem ihren ihrer immer indem ins
ist jede jedem jeden jeder jedes jetzt kann kein keine keinen können könnte lässt man manche mehr mein meine meinem
meinen meiner mich mir mit muss müssen nach nachdem nein nicht nichts noch nun nur oben oder ohne schon sehr sein
seine seinem seinen seiner seit selbst sich sie sind so solche soll sollen sondern sowie statt über um und uns unser
unsere unter viel viele vom von vor wann war waren warum was weil weiter weitere welche welcher wenn wer werden wie
wieder wieso will wir wird wirklich wo wohl worden würde zu zum zur zwar zwischen sir jarvis georg zurück start
gespräche gespräch notiz notizen recherche recherchen bericht stand tagebuch heute morgen gestern uhr montag dienstag
mittwoch donnerstag freitag samstag sonntag januar februar märz april mai juni juli august september oktober november
dezember erledigt gemacht machen öffne öffnen zeig zeige schreib schreibe sagen gesagt geht gehen bitte danke okay
erinnerung erinnere gelernt person personen projekt projekte jahr jahre woche wochen mal neue neuen neuer neues
fazit empfehlung empfehlungen quelle quellen vorteile nachteile überblick zusammenfassung ergebnis ergebnisse beste
besten bester preis preise euro kosten kostet stark wichtig wichtigste sollte sollten etwa ungefähr zwei drei vier
fünf sechs sieben acht neun zehn erste ersten zweite zweiten dritte dritten seite seiten sowie
""".split())

WEEKDAY_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]


@functools.lru_cache(maxsize=50000)
def _stem(word: str) -> str:
    """Grobe Wortfamilie: "Mäuse" und "Maus" bleiben verschieden, aber "Streaming" -> "stream",
    "Overlays" -> "overlay", "Empfehlungen" -> "empfehl"."""
    w = word.lower().strip("-")
    for end in ("ungen", "innen", "ung", "ing", "en", "er", "es", "e", "n", "s"):
        if len(w) - len(end) >= 5 and w.endswith(end):
            return w[: -len(end)]
    return w


def _tokens(text: str):
    """(Wortfamilie, Wort wie geschrieben) für jeden Begriff eines Texts, ohne Füllwörter."""
    for raw in WORD.findall(text or ""):
        parts = raw.split("-") if "-" in raw else []
        for word in [raw] + parts:
            low = word.lower()
            if len(low) < 4 or low in STOP or low.isdigit():
                continue
            yield _stem(low), word


def words(text: str) -> list[str]:
    """Die Begriffe eines Texts (ohne Füllwörter), als Wortfamilien. "Stream-Overlay" zählt als
    "stream-overlay", "stream" und "overlay", damit es auch zu "Streaming" und "Overlays" passt."""
    return [stem for stem, _ in _tokens(text)]


def clean_text(text: str) -> str:
    """Lesbarer Auszug: ohne Jarvis' Markierungen, Überschriften und Link-Klammern."""
    text = MARKER.sub(" ", text or "")
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "Zurück zum [[Start]]" in stripped:
            continue
        lines.append(stripped)
    text = " ".join(lines)
    text = re.sub(r"\[\[([^\]|]+)\|([^\]]+)\]\]", r"\2", text)
    text = re.sub(r"\[\[([^\]]+)\]\]", r"\1", text)
    text = re.sub(r"[*_`>]+", "", text)
    return " ".join(text.split())


def _short(text: str, limit: int) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _day_title(stem: str) -> str:
    try:
        day = dt.date.fromisoformat(stem)
    except ValueError:
        return stem
    return f"{WEEKDAY_SHORT[day.weekday()]} {day.day}.{day.month}."


class Netz:
    """Baut das Netz aus dem Notizbuch-Ordner, der Werkstatt und dem Gedächtnis (alles optional)."""

    def __init__(self, folder: Path | None, workshop=None, memory=None, now=None) -> None:
        self.folder = Path(folder) if folder else None
        self._workshop = workshop
        self._memory = memory
        self._now = now or dt.datetime.now
        self._lock = threading.Lock()
        self._cache: tuple[tuple, float, dict] | None = None
        self._bags: dict[str, set[str]] = {}  # je Knoten seine Schlüsselbegriffe (für related)
        self._paths: dict[str, str] = {}  # je Knoten die Datei oder der Ordner (fürs Öffnen, nicht für die Seite)

    # ------------------------------------------------------------------ Quellen

    def _note_files(self) -> list[Path]:
        if self.folder is None or not self.folder.is_dir():
            return []
        try:
            files = [p for p in self.folder.rglob("*.md") if p.is_file() and ".obsidian" not in p.parts
                     and ".trash" not in p.parts]
        except OSError:
            return []
        days = sorted((p for p in files if p.parent.name.lower() == "tagebuch"), key=lambda p: p.stem, reverse=True)
        others = [p for p in files if p.parent.name.lower() != "tagebuch" and p.stem.lower() != "start"]
        try:
            others.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        except OSError:
            pass
        return (others[: MAX_NOTES - MAX_DAYS] + days[:MAX_DAYS])[:MAX_NOTES]

    def _projects(self) -> list[dict]:
        workshop = self._workshop
        if workshop is None or not hasattr(workshop, "projects"):
            return []
        try:
            return list(workshop.projects())[:MAX_PROJECTS]
        except Exception as exc:
            log.debug("Wissensnetz, Werkstatt: %s", exc)
            return []

    def _facts(self) -> list[str]:
        memory = self._memory
        if memory is None:
            return []
        try:
            return [str(f.get("text", "")) for f in memory.facts()]
        except Exception:
            return []

    def _sessions(self) -> list[dict]:
        memory = self._memory
        if memory is None or not hasattr(memory, "sessions"):
            return []
        try:
            return list(memory.sessions())[-MAX_SESSIONS:]
        except Exception as exc:
            log.debug("Wissensnetz, Sitzungen: %s", exc)
            return []

    def _signature(self, files: list[Path], projects: list[dict], facts: list[str], sessions: list[dict]) -> tuple:
        marks = []
        for path in files:
            try:
                stat = path.stat()
                marks.append((str(path), stat.st_mtime_ns, stat.st_size))
            except OSError:
                continue
        return (tuple(marks), tuple((p.get("name"), p.get("updated"), p.get("state")) for p in projects),
                hash("\n".join(facts)), tuple((s.get("start"), s.get("ende"), bool(s.get("laufend"))) for s in sessions))

    # ------------------------------------------------------------------ Netz

    def build(self, fresh: bool = False) -> dict:
        """{"knoten": [...], "kanten": [...], "zahlen": {...}, "stand": "HH:MM"}"""
        with self._lock:
            if not fresh and self._cache and time.monotonic() - self._cache[1] < REBUILD_SECONDS:
                return self._cache[2]
            files = self._note_files()
            projects = self._projects()
            facts = self._facts()
            sessions = self._sessions()
            signature = self._signature(files, projects, facts, sessions)
            if not fresh and self._cache and self._cache[0] == signature:
                self._cache = (signature, time.monotonic(), self._cache[2])
                return self._cache[2]
            graph = self._build(files, projects, facts, sessions)
            self._cache = (signature, time.monotonic(), graph)
            return graph

    def _build(self, files: list[Path], projects: list[dict], facts: list[str], sessions: list[dict]) -> dict:
        now = self._now()
        nodes: dict[str, dict] = {}
        texts: dict[str, str] = {}
        by_title: dict[str, str] = {}

        paths: dict[str, str] = {}

        def add(node_id: str, title: str, art: str, text: str = "", path: str = "", changed: float | None = None,
                extra: dict | None = None) -> None:
            fresh = changed is not None and time.time() - changed < 24 * 3600
            nodes[node_id] = {"id": node_id, "titel": title, "art": art, "grad": 0, "neu": fresh,
                              "auszug": _short(clean_text(text[:4000]), 180), "datei": self._shown(path),
                              **(extra or {})}
            texts[node_id] = text
            if path:
                paths[node_id] = path
            by_title.setdefault(title.lower(), node_id)

        add("Gedächtnis", "Gedächtnis", "gedaechtnis",
            "\n".join(facts[-40:]) or "Noch leer. Jarvis lernt aus jedem Gespräch dazu.",
            extra={"fakten": len(facts)})
        for path in files:
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
                changed = path.stat().st_mtime
            except OSError:
                continue
            stem = path.stem
            if stem.lower() == "gedächtnis":
                paths["Gedächtnis"] = str(path)
                nodes["Gedächtnis"]["datei"] = self._shown(str(path))
                texts["Gedächtnis"] = text + "\n" + texts["Gedächtnis"]
                continue
            art = FOLDER_ART.get(path.parent.name.lower(), "notiz")
            title = _day_title(stem) if art == "tag" else stem
            node_id = stem if stem not in nodes else f"{path.parent.name}/{stem}"
            add(node_id, title, art, text, str(path), changed)
            by_title.setdefault(stem.lower(), node_id)
        for project in projects:
            name = str(project.get("name") or "").strip()
            if not name:
                continue
            node_id = f"projekt:{name}"
            text = " ".join(str(project.get(k) or "") for k in ("name", "task", "summary"))
            add(node_id, name, "projekt", text, str(project.get("folder") or ""),
                extra={"laeuft": project.get("state") == "running"})
        for session in sessions:
            start = str(session.get("start") or "")
            try:
                when = dt.datetime.fromisoformat(start)
            except ValueError:
                continue
            themes = [str(t) for t in session.get("themen") or []]
            add(f"sitzung:{start}", f"{WEEKDAY_SHORT[when.weekday()]} {when:%H:%M}", "sitzung", "; ".join(themes),
                extra={"anzahl": int(session.get("anzahl") or 0), "laufend": bool(session.get("laufend")),
                       "tag": when.date().isoformat()})

        edges: dict[tuple[str, str], dict] = {}

        def link(a: str, b: str, art: str, why: str = "") -> None:
            if a == b or a not in nodes or b not in nodes:
                return
            key = (a, b) if a < b else (b, a)
            if key in edges:
                return
            edges[key] = {"a": key[0], "b": key[1], "art": art, **({"warum": why} if why else {})}

        # 1. Die [[Links]] aus dem Notizbuch
        for node_id, text in texts.items():
            if nodes[node_id]["art"] in ("projekt", "sitzung"):
                continue
            for target in LINK.findall(text):
                target_id = by_title.get(target.strip().lower())
                if target_id and target.strip().lower() != "start":
                    link(node_id, target_id, "link")
        # 2. Das Gedächtnis kennt Personen und Projekte aus den Fakten, die Sitzungen gehören dazu
        fact_text = " ".join(facts).lower()
        for node_id, node in nodes.items():
            if node["art"] in ("person", "projekt") and len(node["titel"]) >= 3 \
                    and re.search(rf"\b{re.escape(node['titel'].lower())}\b", fact_text):
                link("Gedächtnis", node_id, "gedaechtnis", "steht im Gedächtnis")
            elif node["art"] == "sitzung":
                link("Gedächtnis", node_id, "gedaechtnis", "Sitzung für Sitzung")
                link(node_id, node.get("tag", ""), "link")
        # 3. Erwähnt: ein Tag nennt ein Projekt oder eine Recherche beim Namen (Wort für Wort verglichen,
        #    das ist auch bei 500 Seiten schnell)
        first: dict[str, list[tuple[tuple[str, ...], str]]] = {}
        for i, n in nodes.items():
            if n["art"] in ("projekt", "recherche", "person") and len(n["titel"]) >= 4:
                tokens = tuple(TOKEN.findall(n["titel"].lower()))
                if tokens:
                    first.setdefault(tokens[0], []).append((tokens, i))
        for node_id, node in nodes.items():
            if node["art"] not in ("tag", "notiz", "recherche"):
                continue
            tokens = TOKEN.findall(texts[node_id].lower())
            for at, token in enumerate(tokens):
                for wanted, target_id in first.get(token, ()):
                    if target_id != node_id and tuple(tokens[at:at + len(wanted)]) == wanted:
                        link(node_id, target_id, "erwaehnt", "beim Namen genannt")
        # 4. Automatisch verknüpft: seltene gemeinsame Begriffe (Projekte, Recherchen, Notizen)
        keys, forms = self._keywords(texts, [i for i, n in nodes.items() if n["art"] in ("projekt", "recherche", "notiz")])
        self._auto_links(nodes, keys, link, forms)
        self._bags = {i: set(k) | set(words(nodes[i]["titel"])) for i, k in keys.items()}

        for edge in edges.values():
            nodes[edge["a"]]["grad"] += 1
            nodes[edge["b"]]["grad"] += 1
        counts: dict[str, int] = {}
        for node in nodes.values():
            counts[node["art"]] = counts.get(node["art"], 0) + 1
        order = {art: n for n, art in enumerate(ART_ORDER)}
        knoten = sorted(nodes.values(), key=lambda n: (order.get(n["art"], 9), -n["grad"], n["titel"].lower()))
        kanten = list(edges.values())
        self._paths = paths
        return {
            "knoten": knoten,
            "kanten": kanten,
            "zahlen": {"knoten": len(knoten), "kanten": len(kanten),
                       "auto": sum(1 for e in kanten if e["art"] == "auto"), "art": counts},
            "stand": f"{now:%H:%M}",
        }

    def _shown(self, path: str) -> str:
        """Für die Anzeige: "Recherchen/Gaming-Mäuse.md" statt des ganzen Pfads."""
        if not path:
            return ""
        try:
            if self.folder is not None:
                return Path(path).relative_to(self.folder).as_posix()
        except ValueError:
            pass
        return Path(path).name

    def path_of(self, node_id: str) -> Path | None:
        """Die Datei (Notizbuch) oder der Ordner (Projekt) hinter einem Knoten, None wenn es keine gibt."""
        self.build()
        raw = self._paths.get(str(node_id or ""))
        return Path(raw) if raw else None

    @staticmethod
    def _keywords(texts: dict[str, str], ids: list[str]) -> tuple[dict[str, list[str]], dict[str, str]]:
        """Je Knoten die Begriffe, die ihn von den anderen unterscheiden (häufig hier, selten sonst), und je
        Wortfamilie das Wort, wie es meist geschrieben wird ("mikrofo" -> "Mikrofon")."""
        bags: dict[str, list[str]] = {}
        seen: dict[str, dict[str, int]] = {}
        for i in ids:
            bag = []
            for stem, word in _tokens(texts[i]):
                bag.append(stem)
                counts = seen.setdefault(stem, {})
                counts[word] = counts.get(word, 0) + 1
            bags[i] = bag
        forms = {stem: max(counts.items(), key=lambda item: (item[1], -len(item[0])))[0] for stem, counts in seen.items()}
        df: dict[str, int] = {}
        for bag in bags.values():
            for w in set(bag):
                df[w] = df.get(w, 0) + 1
        n = max(1, len(ids))
        out = {}
        for i, bag in bags.items():
            tf: dict[str, int] = {}
            for w in bag:
                tf[w] = tf.get(w, 0) + 1
            # Begriffe, die in mehr als der Hälfte der Knoten vorkommen, trennen nichts
            scored = [(c * math.log(1 + n / df[w]), w) for w, c in tf.items() if df[w] <= max(3, n * 0.5)]
            scored.sort(reverse=True)
            out[i] = [w for _, w in scored[:TOP_WORDS]]
        return out, forms

    @staticmethod
    def _auto_links(nodes: dict[str, dict], keys: dict[str, list[str]], link, forms: dict[str, str]) -> None:
        ids = list(keys)
        if len(ids) < 2:
            return
        title_words = {i: set(words(nodes[i]["titel"])) for i in ids}
        best: dict[str, list[tuple[float, str, list[str]]]] = {i: [] for i in ids}
        for x in range(len(ids)):
            a = ids[x]
            ka = set(keys[a])
            if not ka:
                continue
            for y in range(x + 1, len(ids)):
                b = ids[y]
                shared = ka & set(keys[b])
                if not shared:
                    continue
                in_title = shared & (title_words[a] | title_words[b])
                score = len(shared) + 1.5 * len(in_title)
                if len(shared) < 2 and not in_title:
                    continue  # ein einzelnes Allerweltswort reicht nicht
                why = [forms.get(w, w) for w in sorted(shared, key=lambda w: (w not in in_title, w))[:3]]
                best[a].append((score, b, why))
                best[b].append((score, a, why))
        for a, found in best.items():
            for score, b, why in sorted(found, reverse=True)[:AUTO_PER_NODE]:
                link(a, b, "auto", "gemeinsam: " + ", ".join(why))

    def related(self, title: str, text: str, limit: int = 3,
                arts: tuple[str, ...] = ("recherche", "notiz", "projekt", "person")) -> list[str]:
        """Die Titel der Seiten, die am besten zu einem neuen Text passen (für "Verwandt:" unter einem neuen
        Bericht): bis zu `limit` Recherchen, Notizen und Projekte mit denselben seltenen Begriffen, dazu bis zu
        zwei Personen, die beim Namen vorkommen."""
        graph = self.build()
        mine = set(words(f"{title} {text}"))
        full = f"{title} {text}"
        own = str(title).strip().lower()
        topics, people = [], []
        for node in graph["knoten"]:
            art = node["art"]
            if art not in arts or node["titel"].lower() == own:
                continue
            if art == "person":
                if re.search(rf"(?<![\wÄÖÜäöüß]){re.escape(node['titel'])}(?![\wÄÖÜäöüß])", full):
                    people.append(node["titel"])
                continue
            shared = mine & self._bags.get(node["id"], set())
            in_title = shared & set(words(node["titel"]))
            if len(shared) >= 2 or in_title:
                topics.append((len(shared) + 2 * len(in_title), node["titel"]))
        topics.sort(key=lambda item: (-item[0], item[1].lower()))
        out: list[str] = []
        for name in [t for _, t in topics][:limit] + people[:2]:
            if name not in out:
                out.append(name)
        return out


KIND_NAMES = {"gedaechtnis": "Gedächtnis", "person": "Person", "projekt": "Projekt", "recherche": "Recherche",
              "notiz": "Notiz", "tag": "Tagebuch", "sitzung": "Sitzung"}
EDGE_NAMES = {"link": "verlinkt", "auto": "automatisch verknüpft", "gedaechtnis": "im Gedächtnis",
              "erwaehnt": "beim Namen genannt"}


def network_text(folder: Path, words: str, limit: int = 12) -> str:
    """Für Claude (jarvis.tool notizbuch-netz): Womit ist diese Seite verknüpft? Ohne passende Seite: die Seiten,
    die zu den Wörtern passen."""
    netz = Netz(folder)
    graph = netz.build(fresh=True)
    nodes = {n["id"]: n for n in graph["knoten"]}
    wanted = " ".join(str(words).split()).lower()
    hit = next((n for n in graph["knoten"] if n["titel"].lower() == wanted or n["id"].lower() == wanted), None)
    if hit is None:
        candidates = [n for n in graph["knoten"] if wanted and wanted in n["titel"].lower()]
        hit = max(candidates, key=lambda n: n["grad"]) if candidates else None
    if hit is None:
        found = netz.related(words, words, limit=5)
        if not found:
            return "Dazu ist im Notizbuch nichts verknüpft."
        return "Passende Seiten: " + ", ".join(found)
    lines = [f"{hit['titel']} ({KIND_NAMES.get(hit['art'], hit['art'])}" + (f", {hit['datei']}" if hit.get("datei") else "")
             + f"): {hit['auszug']}"]
    links = []
    for edge in graph["kanten"]:
        if hit["id"] not in (edge["a"], edge["b"]):
            continue
        other = nodes[edge["b"] if edge["a"] == hit["id"] else edge["a"]]
        links.append((other, edge))
    links.sort(key=lambda item: (ART_ORDER.index(item[0]["art"]) if item[0]["art"] in ART_ORDER else 9, -item[0]["grad"]))
    for other, edge in links[:limit]:
        why = edge.get("warum") or EDGE_NAMES.get(edge["art"], edge["art"])
        lines.append(f"- {other['titel']} ({KIND_NAMES.get(other['art'], other['art'])}): {why}")
    if not links:
        lines.append("- Noch mit nichts verknüpft.")
    elif len(links) > limit:
        lines.append(f"- und {len(links) - limit} weitere")
    return "\n".join(lines)

