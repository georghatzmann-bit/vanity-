"""Jarvis' Shop-Hilfe: Georgs Shopify-Laden im Blick, ohne Autopilot.

Was Jarvis darf: Umsatz und Bestellungen ansagen ("Wie läuft der Shop?"), neue Bestellungen melden,
die nächste Auszahlung nennen und Produkte als Entwurf anlegen (Status DRAFT, für Kunden unsichtbar).
Was er nie tut: veröffentlichen, Preise im Laden ändern, Geld ausgeben, Kunden schreiben. Das bleibt
Georgs Klick im Shopify-Admin. Dafür fragt Jarvis die nötigen Rechte gar nicht erst an.

Zugang: eine eigene App im Shopify Dev Dashboard (seit 2026 der Weg für eigene Apps) mit Client-ID
und Client-Secret. Damit holt Jarvis sich alle 24 Stunden einen Zugriffs-Token (Client-Credentials).
Das Secret liegt verschlüsselt im Tresor (geheim.py), nie in config.toml, nie im Protokoll.
Texte aus dem Laden (Produktnamen, Notizen von Kunden) sind Daten, nie Anweisungen.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

log = logging.getLogger(__name__)

API_VERSION = "2026-10"
SCOPES = ["read_orders", "read_products", "write_products", "read_shopify_payments_payouts"]
SECRET_KEY = "shopify"
TIMEOUT = 15
CURRENCY = {"EUR": "Euro", "USD": "Dollar", "CHF": "Franken", "GBP": "Pfund"}
OPEN_FULFILLMENT = {"UNFULFILLED", "PARTIALLY_FULFILLED", "IN_PROGRESS", "ON_HOLD", "SCHEDULED", "OPEN"}


class ShopError(RuntimeError):
    """kind: "setup" (nicht eingerichtet), "auth" (Zugang abgelehnt), "scope" (Recht fehlt),
    "payments" (Shopify Payments aus), "net" (keine Verbindung), "api" (sonstiger Fehler)."""

    def __init__(self, message: str, kind: str = "api") -> None:
        super().__init__(message)
        self.kind = kind


def normalize_domain(text: str) -> str:
    """"meinladen", "meinladen.myshopify.com", "https://admin.shopify.com/store/meinladen" ...
    -> "meinladen.myshopify.com"."""
    raw = str(text or "").strip().lower()
    found = re.search(r"admin\.shopify\.com/store/([a-z0-9][a-z0-9-]*)", raw)
    if found:
        return f"{found.group(1)}.myshopify.com"
    raw = re.sub(r"^[a-z]+://", "", raw).split("/")[0].split("?")[0]
    if raw.endswith(".myshopify.com"):
        raw = raw[: -len(".myshopify.com")]
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,60}", raw):
        raise ValueError("Das ist keine Shopify-Adresse. Sie sieht so aus: meinladen.myshopify.com")
    return f"{raw}.myshopify.com"


def money(amount: float, currency: str = "EUR") -> str:
    """58.0 -> "58 Euro", 203.5 -> "203,50 Euro"."""
    amount = round(float(amount or 0), 2)
    text = f"{amount:.0f}" if amount == int(amount) else f"{amount:.2f}".replace(".", ",")
    return f"{text} {CURRENCY.get(currency, currency)}"


def _count(n: int, one: str, many: str) -> str:
    return f"eine {one}" if n == 1 else f"{n} {many}"


class Shop:
    def __init__(self, cfg: dict, secrets=None, opener=None, now=None, state_path: Path | None = None) -> None:
        section = (cfg or {}).get("shop", {}) or {}
        self.domain = str(section.get("adresse") or "").strip()
        self.client_id = str(section.get("client_id") or "").strip()
        self.announce_orders = bool(section.get("bestellungen_ansagen", True))
        self._secrets = secrets
        self._opener = opener or urllib.request.build_opener()
        self._now = now or (lambda: dt.datetime.now().astimezone())
        self._state_path = Path(state_path) if state_path else None
        self._token = ""
        self._token_until = 0.0
        self._lock = threading.Lock()
        self.name = ""
        self.currency = "EUR"

    # ------------------------------------------------------------------ Zugang

    @property
    def configured(self) -> bool:
        return bool(self.domain and self.client_id and self._secret())

    def _secret(self) -> str:
        try:
            return self._secrets.get(SECRET_KEY) if self._secrets is not None else ""
        except Exception as exc:
            log.warning("Shop: Secret nicht lesbar: %s", exc)
            return ""

    def _send(self, url: str, data: bytes, headers: dict) -> dict:
        request = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            with self._opener.open(request, timeout=TIMEOUT) as response:
                return json.loads(response.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as exc:
            body = ""
            try:
                body = exc.read().decode("utf-8", "replace")[:300]
            except Exception:
                pass
            if exc.code in (401, 403):
                raise ShopError("Shopify lehnt den Zugang ab. Bitte Client-ID und Secret prüfen "
                                "(Dev Dashboard > Einstellungen > Anmeldedaten).", "auth") from exc
            if exc.code == 404:
                raise ShopError("Diesen Shop kennt Shopify nicht. Stimmt die Adresse?", "setup") from exc
            log.warning("Shopify %s: %s", exc.code, body)
            raise ShopError(f"Shopify antwortet mit Fehler {exc.code}.", "api") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ShopError("Shopify ist gerade nicht erreichbar (Internet?).", "net") from exc
        except ValueError as exc:
            raise ShopError("Shopify hat etwas Unverständliches geantwortet.", "api") from exc

    def token(self, force: bool = False) -> str:
        """Zugriffs-Token per Client-Credentials, 24 Stunden gültig (5 Minuten vorher erneuern)."""
        if not self.domain or not self.client_id:
            raise ShopError("Der Shop ist noch nicht verbunden.", "setup")
        secret = self._secret()
        if not secret:
            raise ShopError("Das Client-Secret fehlt. Bitte im Fenster unter Verbinden > Shop neu eintragen.", "setup")
        with self._lock:
            if self._token and not force and time.monotonic() < self._token_until:
                return self._token
            data = urllib.parse.urlencode({"grant_type": "client_credentials", "client_id": self.client_id,
                                           "client_secret": secret}).encode("ascii")
            reply = self._send(f"https://{self.domain}/admin/oauth/access_token", data,
                               {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"})
            token = str(reply.get("access_token") or "")
            if not token:
                raise ShopError("Shopify hat keinen Zugang ausgegeben. Ist die App im Shop installiert?", "auth")
            self._token = token
            self._token_until = time.monotonic() + max(60, int(reply.get("expires_in") or 86399) - 300)
            granted = set(str(reply.get("scope") or "").split(","))
            missing = [s for s in SCOPES if granted and s not in granted]
            if missing:
                log.info("Shopify: diese Rechte fehlen der App: %s", ", ".join(missing))
            return token

    def graphql(self, query: str, variables: dict | None = None) -> dict:
        """Eine Abfrage an die Admin-API. Bei abgelaufenem Token einmal neu holen, bei zu vielen
        Anfragen (THROTTLED) kurz warten und einmal nochmal."""
        body = json.dumps({"query": query, "variables": variables or {}}).encode("utf-8")
        url = f"https://{self.domain}/admin/api/{API_VERSION}/graphql.json"
        for attempt in range(3):
            headers = {"Content-Type": "application/json", "X-Shopify-Access-Token": self.token(force=attempt == 1)}
            try:
                reply = self._send(url, body, headers)
            except ShopError as exc:
                if exc.kind == "auth" and attempt == 0:
                    continue  # Token abgelaufen oder widerrufen: einmal neu holen
                raise
            errors = reply.get("errors") or []
            if errors:
                codes = {str((e.get("extensions") or {}).get("code") or "") for e in errors if isinstance(e, dict)}
                text = "; ".join(str(e.get("message", e)) if isinstance(e, dict) else str(e) for e in errors)
                if "THROTTLED" in codes and attempt < 2:
                    time.sleep(2)
                    continue
                if "ACCESS_DENIED" in codes or "access denied" in text.lower():
                    raise ShopError("Der Jarvis-App fehlt dafür ein Recht. Im Dev Dashboard unter Zugriff die "
                                    "Bereiche aus der Anleitung eintragen und neu veröffentlichen.", "scope")
                raise ShopError(f"Shopify meldet: {text[:200]}", "api")
            return reply.get("data") or {}
        raise ShopError("Shopify ist gerade überlastet. Bitte gleich nochmal.", "api")

    # ------------------------------------------------------------------ Lesen

    def info(self) -> dict:
        data = self.graphql("{ shop { name currencyCode ianaTimezone myshopifyDomain } }")
        shop = data.get("shop") or {}
        self.name = str(shop.get("name") or self.domain)
        self.currency = str(shop.get("currencyCode") or "EUR")
        return {"name": self.name, "waehrung": self.currency, "zeitzone": str(shop.get("ianaTimezone") or ""),
                "adresse": str(shop.get("myshopifyDomain") or self.domain)}

    ORDERS = """query($q: String!, $after: String) {
  orders(first: 100, query: $q, sortKey: CREATED_AT, reverse: true, after: $after) {
    edges { node {
      id name createdAt cancelledAt test
      displayFinancialStatus displayFulfillmentStatus
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 10) { edges { node { title quantity } } }
    } }
    pageInfo { hasNextPage endCursor }
  }
}"""

    def orders_since(self, since: dt.datetime, limit: int = 500) -> list[dict]:
        """Bestellungen seit `since` (neueste zuerst), ohne Testbestellungen."""
        stamp = since.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        query = f"created_at:>='{stamp}'"
        found, after = [], None
        while len(found) < limit:
            data = self.graphql(self.ORDERS, {"q": query, "after": after})
            block = data.get("orders") or {}
            for edge in block.get("edges") or []:
                node = edge.get("node") or {}
                if node.get("test"):
                    continue
                price = ((node.get("currentTotalPriceSet") or {}).get("shopMoney") or {})
                items = [(str((e.get("node") or {}).get("title") or ""), int((e.get("node") or {}).get("quantity") or 0))
                         for e in ((node.get("lineItems") or {}).get("edges") or [])]
                found.append({
                    "id": str(node.get("id") or ""), "name": str(node.get("name") or ""),
                    "created": str(node.get("createdAt") or ""), "cancelled": bool(node.get("cancelledAt")),
                    "total": float(price.get("amount") or 0), "currency": str(price.get("currencyCode") or self.currency),
                    "paid": str(node.get("displayFinancialStatus") or ""),
                    "fulfillment": str(node.get("displayFulfillmentStatus") or ""), "items": items,
                })
            info = block.get("pageInfo") or {}
            if not info.get("hasNextPage"):
                break
            after = info.get("endCursor")
        return found

    def summary(self) -> dict:
        """Heute, diese Woche (ab Montag), was noch auf den Versand wartet und was am besten läuft."""
        now = self._now()
        today = now.replace(hour=0, minute=0, second=0, microsecond=0)
        week = today - dt.timedelta(days=today.weekday())
        orders = [o for o in self.orders_since(week) if not o["cancelled"]]

        def created(order):
            try:
                return dt.datetime.fromisoformat(order["created"].replace("Z", "+00:00"))
            except ValueError:
                return week

        todays = [o for o in orders if created(o) >= today]
        best: dict[str, int] = {}
        for order in orders:
            for title, quantity in order["items"]:
                if title:
                    best[title] = best.get(title, 0) + quantity
        currency = orders[0]["currency"] if orders else self.currency
        return {
            "heute": {"anzahl": len(todays), "umsatz": round(sum(o["total"] for o in todays), 2)},
            "woche": {"anzahl": len(orders), "umsatz": round(sum(o["total"] for o in orders), 2)},
            "offen": sum(1 for o in orders if o["fulfillment"].upper() in OPEN_FULFILLMENT),
            "bestseller": sorted(best.items(), key=lambda kv: (-kv[1], kv[0]))[:3],
            "waehrung": currency,
        }

    PAYOUTS = """{ shopifyPaymentsAccount { payouts(first: 20) { edges { node {
  id status issuedAt net { amount currencyCode }
} } } } }"""

    def payouts(self) -> list[dict]:
        data = self.graphql(self.PAYOUTS)
        account = data.get("shopifyPaymentsAccount")
        if account is None:
            raise ShopError("Shopify Payments ist in diesem Shop nicht eingerichtet, Sir. Ohne das gibt es "
                            "keine Auszahlungen, die ich ansagen kann.", "payments")
        found = []
        for edge in (account.get("payouts") or {}).get("edges") or []:
            node = edge.get("node") or {}
            net = node.get("net") or {}
            found.append({"status": str(node.get("status") or ""), "datum": str(node.get("issuedAt") or "")[:10],
                          "betrag": float(net.get("amount") or 0), "waehrung": str(net.get("currencyCode") or "EUR")})
        return sorted(found, key=lambda p: p["datum"])

    def new_orders(self) -> list[dict]:
        """Bestellungen, die seit dem letzten Blick neu sind (für "Neue Bestellung, Sir"). Beim
        allerersten Mal merkt Jarvis sich nur den Stand, damit er nicht alte Bestellungen ansagt."""
        state = self._load_state()
        now = self._now()
        since = now - dt.timedelta(days=2)
        orders = [o for o in self.orders_since(since, limit=200) if not o["cancelled"]]
        seen = set(state.get("gesehen") or [])
        first = not state.get("gesehen") and not state.get("begonnen")
        fresh = [] if first else [o for o in orders if o["id"] not in seen]
        state["gesehen"] = [o["id"] for o in orders][:300]
        state["begonnen"] = now.isoformat()
        self._save_state(state)
        return list(reversed(fresh))  # älteste zuerst ansagen

    def _load_state(self) -> dict:
        if self._state_path is None:
            return {}
        try:
            data = json.loads(self._state_path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save_state(self, state: dict) -> None:
        if self._state_path is None:
            return
        try:
            self._state_path.parent.mkdir(parents=True, exist_ok=True)
            self._state_path.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
        except OSError as exc:
            log.debug("Shop-Stand: %s", exc)

    # ------------------------------------------------------------------ Entwürfe

    CREATE = """mutation($product: ProductCreateInput!) {
  productCreate(product: $product) {
    product { id title handle status variants(first: 1) { edges { node { id } } } }
    userErrors { field message }
  }
}"""
    PRICE = """mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id price }
    userErrors { field message }
  }
}"""

    def draft(self, title: str, description: str = "", price: float | None = None, tags: list[str] | None = None,
              product_type: str = "") -> dict:
        """Legt ein Produkt als Entwurf an. Es ist für Kunden unsichtbar, bis Georg es im
        Shopify-Admin selbst veröffentlicht. Eine Veröffentlichung gibt es hier absichtlich nicht."""
        title = " ".join(str(title or "").split())[:255]
        if len(title) < 2:
            raise ShopError("Wie soll das Produkt heißen, Sir?", "api")
        product = {"title": title, "status": "DRAFT"}
        if description:
            paragraphs = [p.strip() for p in str(description).split("\n\n") if p.strip()]
            product["descriptionHtml"] = "".join(f"<p>{_html(p)}</p>" for p in paragraphs)[:20000]
        if tags:
            product["tags"] = [str(t).strip()[:60] for t in tags if str(t).strip()][:20]
        if product_type:
            product["productType"] = str(product_type)[:60]
        data = self.graphql(self.CREATE, {"product": product})
        result = data.get("productCreate") or {}
        problems = [e.get("message", "") for e in result.get("userErrors") or [] if isinstance(e, dict)]
        made = result.get("product") or {}
        if problems or not made.get("id"):
            raise ShopError("Shopify hat den Entwurf nicht angenommen: " + ("; ".join(problems) or "unbekannt"), "api")
        if price is not None and price > 0:
            variants = (made.get("variants") or {}).get("edges") or []
            if variants:
                priced = self.graphql(self.PRICE, {"productId": made["id"], "variants": [
                    {"id": variants[0]["node"]["id"], "price": f"{float(price):.2f}"}]})
                errors = [e.get("message", "") for e in ((priced.get("productVariantsBulkUpdate") or {})
                                                         .get("userErrors") or []) if isinstance(e, dict)]
                if errors:
                    log.warning("Shopify Preis: %s", "; ".join(errors))
        number = str(made["id"]).rsplit("/", 1)[-1]
        store = self.domain.split(".")[0]
        return {"id": made["id"], "title": str(made.get("title") or title), "status": str(made.get("status") or "DRAFT"),
                "link": f"https://admin.shopify.com/store/{store}/products/{number}"}


def _html(text: str) -> str:
    return (text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace("\n", "<br>"))


# ---------------------------------------------------------------------- Sätze

def spoken_summary(summary: dict) -> str:
    """"Heute 2 Bestellungen über 58 Euro, Sir. Diese Woche 7, zusammen 203,50 Euro. 3 warten
    noch auf den Versand." """
    currency = summary.get("waehrung", "EUR")
    today, week = summary["heute"], summary["woche"]
    if today["anzahl"]:
        first = f"Heute {_count(today['anzahl'], 'Bestellung', 'Bestellungen')} über {money(today['umsatz'], currency)}, Sir."
    else:
        first = "Heute noch keine Bestellung, Sir."
    if week["anzahl"] > today["anzahl"]:
        second = f" Diese Woche {week['anzahl']}, zusammen {money(week['umsatz'], currency)}."
    elif not week["anzahl"]:
        second = " Diese Woche auch noch keine."
    else:
        second = ""
    open_orders = summary.get("offen", 0)
    third = ""
    if open_orders:
        third = (" Eine wartet noch auf den Versand." if open_orders == 1
                 else f" {open_orders} warten noch auf den Versand.")
    best = summary.get("bestseller") or []
    fourth = f" Am besten läuft {best[0][0]}." if best and week["anzahl"] >= 3 else ""
    return first + second + third + fourth


def spoken_payout(payouts: list[dict], today: dt.date | None = None) -> str:
    today = today or dt.date.today()
    coming = [p for p in payouts if p["status"].upper() in ("SCHEDULED", "IN_TRANSIT") and p["datum"] >= today.isoformat()]
    if coming:
        nxt = coming[0]
        day = dt.date.fromisoformat(nxt["datum"])
        when = "heute" if day == today else "morgen" if day == today + dt.timedelta(days=1) else f"am {day.day}.{day.month}."
        return f"Die nächste Auszahlung kommt {when}, Sir: {money(nxt['betrag'], nxt['waehrung'])}."
    paid = [p for p in payouts if p["status"].upper() == "PAID"]
    if paid:
        last = paid[-1]
        day = dt.date.fromisoformat(last["datum"])
        return (f"Gerade ist keine Auszahlung unterwegs, Sir. Die letzte waren {money(last['betrag'], last['waehrung'])} "
                f"am {day.day}.{day.month}.")
    return "Bisher gab es keine Auszahlung, Sir."


def spoken_order(order: dict) -> str:
    """"Neue Bestellung im Shop, Sir: 29 Euro, Mauspad Jarvis." """
    items = [f"{q} × {t}" if q > 1 else t for t, q in order.get("items", []) if t][:2]
    what = f", {', '.join(items)}" if items else ""
    return f"Neue Bestellung im Shop, Sir: {money(order['total'], order.get('currency', 'EUR'))}{what}."


_SUMMARY = re.compile(
    r"\b(?:wie\s+(?:läuft|lief|geht'?s|geht\s+es)\s+(?:dem\s+|meinem\s+|der\s+|mein(?:em)?\s+|im\s+)?(?:shop|laden|onlineshop|store)"
    r"|was\s+(?:macht|tut\s+sich\s+(?:im|in\s+meinem))\s+(?:der\s+|mein\s+)?(?:shop|laden)"
    r"|(?:shop|laden)[-\s]?(?:bericht|stand|zahlen|umsatz)"
    r"|(?:wie\s+viel|wieviel)\s+(?:habe|hab)\s+ich\s+(?:heute|diese\s+woche|bisher)?\s*(?:verkauft|umgesetzt|eingenommen)"
    r"|(?:wie\s+viel|wieviel|was)\s+(?:umsatz|verkauft)"
    r"|(?:umsatz|verkäufe)\s+(?:heute|diese\s+woche|im\s+shop)"
    r"|(?:gibt\s+es\s+|gab\s+es\s+|hab(?:e)?\s+ich\s+)?neue\s+bestellungen"
    r"|wie\s+viele\s+bestellungen)\b",
    re.I,
)
_PAYOUT = re.compile(r"\b(?:wann\s+kommt\s+(?:die\s+(?:nächste\s+)?auszahlung|(?:das|mein)\s+geld)"
                     r"|(?:nächste|letzte)\s+auszahlung|auszahlungen?\s+(?:von|im)\s+shop|shopify[-\s]auszahlung)\b", re.I)


def match_shop(text: str) -> str | None:
    """"summary" für den Überblick, "payout" für die Auszahlung, sonst None."""
    raw = " ".join(str(text).split())
    if _PAYOUT.search(raw):
        return "payout"
    if _SUMMARY.search(raw):
        return "summary"
    return None
