"""Webseiten und Suchen ohne Umweg über Claude: ein Name wird zur Adresse, eine Suche
zur Ergebnisseite. Windows öffnet den Link im Standard-Browser, das geht sofort.

Nur "Spiel X auf YouTube" fragt einmal kurz bei YouTube nach dem ersten Video (meist
unter einer Sekunde), damit es gleich läuft statt nur die Trefferliste zu zeigen.
"""

from __future__ import annotations

import logging
import re
import urllib.parse
import urllib.request

log = logging.getLogger(__name__)

# Gesprochener Name -> (Anzeige, Adresse). Die Schlüssel sind klein und ohne Satzzeichen,
# Varianten ohne Leerzeichen findet site() von selbst ("youtubemusic").
SITES: dict[str, tuple[str, str]] = {
    "youtube": ("YouTube", "https://www.youtube.com"),
    "youtube music": ("YouTube Music", "https://music.youtube.com"),
    "google": ("Google", "https://www.google.com"),
    "gmail": ("Gmail", "https://mail.google.com"),
    "google mail": ("Gmail", "https://mail.google.com"),
    "google drive": ("Google Drive", "https://drive.google.com"),
    "google docs": ("Google Docs", "https://docs.google.com"),
    "google fotos": ("Google Fotos", "https://photos.google.com"),
    "google kalender": ("Google Kalender", "https://calendar.google.com"),
    "google übersetzer": ("Google Übersetzer", "https://translate.google.com"),
    "google translate": ("Google Übersetzer", "https://translate.google.com"),
    "übersetzer": ("Google Übersetzer", "https://translate.google.com"),
    "deepl": ("DeepL", "https://www.deepl.com/translator"),
    "google maps": ("Google Maps", "https://www.google.com/maps"),
    "maps": ("Google Maps", "https://www.google.com/maps"),
    "google news": ("Google News", "https://news.google.com/?hl=de&gl=AT&ceid=AT:de"),
    "outlook": ("Outlook", "https://outlook.live.com"),
    "hotmail": ("Outlook", "https://outlook.live.com"),
    "twitch": ("Twitch", "https://www.twitch.tv"),
    "kick": ("Kick", "https://kick.com"),
    "reddit": ("Reddit", "https://www.reddit.com"),
    "instagram": ("Instagram", "https://www.instagram.com"),
    "tiktok": ("TikTok", "https://www.tiktok.com"),
    "facebook": ("Facebook", "https://www.facebook.com"),
    "twitter": ("X", "https://x.com"),
    "linkedin": ("LinkedIn", "https://www.linkedin.com"),
    "pinterest": ("Pinterest", "https://www.pinterest.com"),
    "amazon": ("Amazon", "https://www.amazon.de"),
    "ebay": ("eBay", "https://www.ebay.at"),
    "willhaben": ("willhaben", "https://www.willhaben.at"),
    "geizhals": ("Geizhals", "https://geizhals.at"),
    "idealo": ("idealo", "https://www.idealo.at"),
    "zalando": ("Zalando", "https://www.zalando.at"),
    "mediamarkt": ("MediaMarkt", "https://www.mediamarkt.at"),
    "ikea": ("IKEA", "https://www.ikea.com/at/de/"),
    "paypal": ("PayPal", "https://www.paypal.com"),
    "booking": ("Booking.com", "https://www.booking.com"),
    "airbnb": ("Airbnb", "https://www.airbnb.at"),
    "lieferando": ("Lieferando", "https://www.lieferando.at"),
    "foodora": ("foodora", "https://www.foodora.at"),
    "öbb": ("ÖBB", "https://www.oebb.at"),
    "oebb": ("ÖBB", "https://www.oebb.at"),
    "wikipedia": ("Wikipedia", "https://de.wikipedia.org"),
    "github": ("GitHub", "https://github.com"),
    "stack overflow": ("Stack Overflow", "https://stackoverflow.com"),
    "chatgpt": ("ChatGPT", "https://chatgpt.com"),
    "claude": ("Claude", "https://claude.ai"),
    "orf": ("ORF", "https://orf.at"),
    "orf on": ("ORF ON", "https://on.orf.at"),
    "tvthek": ("ORF ON", "https://on.orf.at"),
    "der standard": ("Der Standard", "https://www.derstandard.at"),
    "standard": ("Der Standard", "https://www.derstandard.at"),
    "krone": ("Krone", "https://www.krone.at"),
    "kronen zeitung": ("Krone", "https://www.krone.at"),
    "kurier": ("Kurier", "https://kurier.at"),
    "oe24": ("oe24", "https://www.oe24.at"),
    "die presse": ("Die Presse", "https://www.diepresse.com"),
    "spiegel": ("Spiegel", "https://www.spiegel.de"),
    "tagesschau": ("Tagesschau", "https://www.tagesschau.de"),
    "netflix": ("Netflix", "https://www.netflix.com"),
    "prime video": ("Prime Video", "https://www.primevideo.com"),
    "amazon prime": ("Prime Video", "https://www.primevideo.com"),
    "disney plus": ("Disney Plus", "https://www.disneyplus.com"),
    "disney": ("Disney Plus", "https://www.disneyplus.com"),
    "crunchyroll": ("Crunchyroll", "https://www.crunchyroll.com"),
    "dazn": ("DAZN", "https://www.dazn.com"),
    "joyn": ("Joyn", "https://www.joyn.at"),
    "soundcloud": ("SoundCloud", "https://soundcloud.com"),
    "apple music": ("Apple Music", "https://music.apple.com"),
    "whatsapp web": ("WhatsApp Web", "https://web.whatsapp.com"),
    "telegram web": ("Telegram Web", "https://web.telegram.org"),
    "steam store": ("Steam Shop", "https://store.steampowered.com"),
    "steam shop": ("Steam Shop", "https://store.steampowered.com"),
    "epic games store": ("Epic Games Store", "https://store.epicgames.com"),
    "canva": ("Canva", "https://www.canva.com"),
    "notion": ("Notion", "https://www.notion.so"),
    "dropbox": ("Dropbox", "https://www.dropbox.com"),
    "onedrive": ("OneDrive", "https://onedrive.live.com"),
    "icloud": ("iCloud", "https://www.icloud.com"),
    "chess": ("Chess.com", "https://www.chess.com"),
    "duolingo": ("Duolingo", "https://www.duolingo.com"),
    "speedtest": ("Speedtest", "https://www.speedtest.net"),
}

# Suchseiten: Name -> (Anzeige, Vorlage mit {q}). "google" ist die Standard-Suche.
SEARCH: dict[str, tuple[str, str]] = {
    "google": ("Google", "https://www.google.com/search?q={q}"),
    "internet": ("Google", "https://www.google.com/search?q={q}"),
    "youtube": ("YouTube", "https://www.youtube.com/results?search_query={q}"),
    "amazon": ("Amazon", "https://www.amazon.de/s?k={q}"),
    "ebay": ("eBay", "https://www.ebay.at/sch/i.html?_nkw={q}"),
    "willhaben": ("willhaben", "https://www.willhaben.at/iad/kaufen-und-verkaufen/marktplatz?keyword={q}"),
    "geizhals": ("Geizhals", "https://geizhals.at/?fs={q}"),
    "idealo": ("idealo", "https://www.idealo.at/preisvergleich/MainSearchProductCategory.html?q={q}"),
    "wikipedia": ("Wikipedia", "https://de.wikipedia.org/w/index.php?search={q}"),
    "reddit": ("Reddit", "https://www.reddit.com/search/?q={q}"),
    "twitch": ("Twitch", "https://www.twitch.tv/search?term={q}"),
    "github": ("GitHub", "https://github.com/search?q={q}"),
    "netflix": ("Netflix", "https://www.netflix.com/search?q={q}"),
    "tiktok": ("TikTok", "https://www.tiktok.com/search?q={q}"),
    "steam": ("Steam", "https://store.steampowered.com/search/?term={q}"),
    "stack overflow": ("Stack Overflow", "https://stackoverflow.com/search?q={q}"),
    "google maps": ("Google Maps", "https://www.google.com/maps/search/?api=1&query={q}"),
    "maps": ("Google Maps", "https://www.google.com/maps/search/?api=1&query={q}"),
    "karte": ("Google Maps", "https://www.google.com/maps/search/?api=1&query={q}"),
    "bilder": ("Google Bilder", "https://www.google.com/search?tbm=isch&q={q}"),
    "google bilder": ("Google Bilder", "https://www.google.com/search?tbm=isch&q={q}"),
    "news": ("Google News", "https://news.google.com/search?q={q}&hl=de&gl=AT&ceid=AT:de"),
    "nachrichten": ("Google News", "https://news.google.com/search?q={q}&hl=de&gl=AT&ceid=AT:de"),
    "spotify": ("Spotify", "https://open.spotify.com/search/{q}"),
}
DIRECTIONS = "https://www.google.com/maps/dir/?api=1&destination={q}"
# DuckDuckGo springt bei einem "\" vor der Suche direkt zum ersten Treffer.
FIRST_HIT = "https://duckduckgo.com/?q=%5C{q}"

_TLD = r"(?:at|de|com|net|org|ch|eu|io|ai|tv|gg|co|uk|info|app|dev|me|so|ly|fm|to)"
_DOMAIN = re.compile(rf"^(?:https?://)?(?:www\.)?((?:[a-z0-9äöü-]+\.)+{_TLD})(/\S*)?$", re.I)


def key(name: str) -> str:
    """So werden Namen verglichen: klein, ohne Satzzeichen, einfache Leerzeichen."""
    text = str(name).lower().replace("+", " plus ").replace("&", " und ")
    text = re.sub(r"[^\wäöüß]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def domain(name: str) -> str | None:
    """"amazon.de", "orf punkt at", "www.google.com/maps" -> Adresse ohne https://, sonst None."""
    text = str(name).strip().strip("\"'„“").lower()
    text = re.sub(r"\s+(?:punkt|dot)\s+", ".", text)
    text = re.sub(r"\s*\.\s*", ".", text)
    found = _DOMAIN.match(text)
    if not found:
        return None
    return found.group(1) + (found.group(2) or "")


def site(name: str) -> tuple[str, str] | None:
    """(Anzeige, Adresse) für einen gesprochenen Seitennamen oder eine Domain, sonst None."""
    raw = str(name).strip()
    host = domain(raw)
    if host:
        # "amazon.de" heißt beim Sprechen "Amazon", unbekannte Domains so, wie sie sind
        known = SITES.get(host.split(".")[0])
        return (known[0] if known else host.split("/")[0]), "https://" + host
    wanted = key(raw)
    wanted = re.sub(r"^(?:die |der |das )?(?:seite |webseite |website |homepage )?(?:von |vom )?", "", wanted)
    wanted = re.sub(r" (?:seite|webseite|website|homepage)$", "", wanted)
    if not wanted:
        return None
    if wanted in SITES:
        return SITES[wanted]
    squashed = wanted.replace(" ", "")
    for name_key, value in SITES.items():
        if name_key.replace(" ", "") == squashed:
            return value
    return None


def search_engine(name: str) -> tuple[str, str] | None:
    wanted = key(name)
    wanted = re.sub(r"^(?:der |die |dem |den )", "", wanted)
    return SEARCH.get(wanted) or SEARCH.get(wanted.replace(" ", ""))


def search_url(engine: str, query: str) -> tuple[str, str]:
    """(Anzeige, Adresse) einer Suche. Unbekannte Suchseiten werden zur Google-Suche."""
    label, template = search_engine(engine) or SEARCH["google"]
    # Im Pfad (".../search/{q}") gehören Leerzeichen als %20 hinein, in "?q=" als +.
    quote = urllib.parse.quote if "/{q}" in template else urllib.parse.quote_plus
    return label, template.replace("{q}", quote(query.strip()))


def directions_url(destination: str) -> str:
    return DIRECTIONS.replace("{q}", urllib.parse.quote_plus(destination.strip()))


def first_hit_url(query: str) -> str:
    """Für "Öffne die Seite von <irgendwas>": direkt zum ersten Suchtreffer."""
    return FIRST_HIT.replace("{q}", urllib.parse.quote_plus(query.strip()))


# ---------------------------------------------------------------------- YouTube

_VIDEO = [
    re.compile(r'"videoRenderer":\{"videoId":"([\w-]{11})"'),
    re.compile(r'"videoId":"([\w-]{11})"'),
    re.compile(r"/watch\?v=([\w-]{11})"),
]


def first_video(query: str, timeout: float = 2.5, fetch=None) -> str | None:
    """Die ID des ersten YouTube-Treffers, oder None (dann öffnet Jarvis die Trefferliste)."""
    url = "https://www.youtube.com/results?" + urllib.parse.urlencode({"search_query": query.strip()})
    try:
        html = (fetch or _fetch)(url, timeout)
    except Exception as exc:
        log.info("YouTube-Suche ging nicht: %s", exc)
        return None
    for pattern in _VIDEO:
        found = pattern.search(html)
        if found:
            return found.group(1)
    return None


def video_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def _fetch(url: str, timeout: float) -> str:
    request = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                      "Chrome/126.0 Safari/537.36",
        "Accept-Language": "de-AT,de;q=0.9,en;q=0.6",
        # Ohne diese Cookies leitet YouTube in der EU erst zur Zustimmungsseite um.
        "Cookie": "SOCS=CAI; CONSENT=YES+1",
    })
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read(1_500_000).decode("utf-8", errors="replace")
