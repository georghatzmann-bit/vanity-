"""Shop-Hilfe: Shopify lesen, Entwürfe anlegen, nie veröffentlichen (nachgebautes Shopify)."""

import datetime as dt
import io
import json
import tempfile
import unittest
import urllib.error
import urllib.parse
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import tests.helpers  # noqa: F401
from jarvis import shop as shopmod
from jarvis.shop import Shop, ShopError, match_shop, money, normalize_domain, spoken_order, spoken_payout, spoken_summary

VIENNA = dt.timezone(dt.timedelta(hours=2))
NOW = dt.datetime(2026, 10, 2, 15, 0, tzinfo=VIENNA)  # Freitag


class Vault:
    def __init__(self, **values):
        self.values = dict(values)

    def get(self, key):
        return self.values.get(key, "")

    def set(self, key, value):
        self.values[key] = value

    def delete(self, key):
        return self.values.pop(key, None) is not None

    def has(self, key):
        return key in self.values


def order(oid, when, total, fulfillment="UNFULFILLED", items=(("Mauspad Jarvis", 1),), cancelled=False, test=False):
    return {"node": {
        "id": f"gid://shopify/Order/{oid}", "name": f"#{oid}", "createdAt": when, "cancelledAt": "x" if cancelled else None,
        "test": test, "displayFinancialStatus": "PAID", "displayFulfillmentStatus": fulfillment,
        "currentTotalPriceSet": {"shopMoney": {"amount": str(total), "currencyCode": "EUR"}},
        "lineItems": {"edges": [{"node": {"title": t, "quantity": q}} for t, q in items]},
    }}


class FakeShopify:
    """Antwortet wie Shopify: Token per Client-Credentials, danach GraphQL."""

    def __init__(self):
        self.calls = []
        self.orders = []
        self.token_status = 200
        self.throttle = 0
        self.payments = True

    def open(self, request, timeout=None):
        url = request.full_url
        body = request.data.decode("utf-8")
        self.calls.append((url, dict(request.header_items()), body))
        if url.endswith("/admin/oauth/access_token"):
            form = dict(urllib.parse.parse_qsl(body))
            if self.token_status != 200 or form.get("client_secret") != "geheim-123":
                raise urllib.error.HTTPError(url, 401, "Unauthorized", {}, io.BytesIO(b'{"error":"invalid_client"}'))
            return self._reply({"access_token": "tok-1", "scope": ",".join(shopmod.SCOPES), "expires_in": 86399})
        assert url.endswith(f"/admin/api/{shopmod.API_VERSION}/graphql.json"), url
        headers = {k.lower(): v for k, v in request.header_items()}
        assert headers["x-shopify-access-token"] == "tok-1"
        payload = json.loads(body)
        query = payload["query"]
        if self.throttle:
            self.throttle -= 1
            return self._reply({"errors": [{"message": "Throttled", "extensions": {"code": "THROTTLED"}}]})
        if "shop {" in query:
            return self._reply({"data": {"shop": {"name": "Georgs Laden", "currencyCode": "EUR",
                                                  "ianaTimezone": "Europe/Vienna", "myshopifyDomain": "georg.myshopify.com"}}})
        if "orders(" in query:
            since = payload["variables"]["q"].split("'")[1]
            found = [o for o in self.orders if o["node"]["createdAt"] >= since]
            return self._reply({"data": {"orders": {"edges": found, "pageInfo": {"hasNextPage": False, "endCursor": None}}}})
        if "shopifyPaymentsAccount" in query:
            if not self.payments:
                return self._reply({"data": {"shopifyPaymentsAccount": None}})
            return self._reply({"data": {"shopifyPaymentsAccount": {"payouts": {"edges": [
                {"node": {"id": "p1", "status": "PAID", "issuedAt": "2026-09-28T00:00:00Z", "net": {"amount": "80.10", "currencyCode": "EUR"}}},
                {"node": {"id": "p2", "status": "SCHEDULED", "issuedAt": "2026-10-03T00:00:00Z", "net": {"amount": "112.00", "currencyCode": "EUR"}}},
            ]}}}})
        if "productCreate" in query:
            product = payload["variables"]["product"]
            assert product["status"] == "DRAFT"
            return self._reply({"data": {"productCreate": {"product": {
                "id": "gid://shopify/Product/555", "title": product["title"], "handle": "x", "status": "DRAFT",
                "variants": {"edges": [{"node": {"id": "gid://shopify/ProductVariant/9"}}]}}, "userErrors": []}}})
        if "productVariantsBulkUpdate" in query:
            return self._reply({"data": {"productVariantsBulkUpdate": {"productVariants": [
                {"id": "gid://shopify/ProductVariant/9", "price": payload["variables"]["variants"][0]["price"]}],
                "userErrors": []}}})
        raise AssertionError("unbekannte Abfrage: " + query[:80])

    @staticmethod
    def _reply(data):
        return mock.MagicMock(**{"read.return_value": json.dumps(data).encode("utf-8"),
                                 "__enter__.return_value": mock.MagicMock(read=lambda: json.dumps(data).encode("utf-8")),
                                 "__exit__.return_value": False})


def make_shop(fake, folder=None, **cfg):
    section = {"adresse": "georg.myshopify.com", "client_id": "cid-1"}
    section.update(cfg)
    return Shop({"shop": section}, Vault(shopify="geheim-123"), opener=fake, now=lambda: NOW,
                state_path=Path(folder) / "shop.json" if folder else None)


class HelperTest(unittest.TestCase):
    def test_domains_and_money(self):
        for text in ("georg", "georg.myshopify.com", "https://georg.myshopify.com/admin/products",
                     "admin.shopify.com/store/georg/orders"):
            self.assertEqual(normalize_domain(text), "georg.myshopify.com", text)
        with self.assertRaises(ValueError):
            normalize_domain("das ist kein shop!")
        self.assertEqual(money(58), "58 Euro")
        self.assertEqual(money(203.5), "203,50 Euro")
        self.assertEqual(money(10, "USD"), "10 Dollar")

    def test_sentences(self):
        for said in ("Wie läuft der Shop?", "Wie läuft mein Laden", "Wie viel habe ich heute verkauft?",
                     "Gibt es neue Bestellungen?", "Umsatz heute", "Wie viele Bestellungen habe ich?"):
            self.assertEqual(match_shop(said), "summary", said)
        for said in ("Wann kommt die nächste Auszahlung?", "Wann kommt mein Geld?"):
            self.assertEqual(match_shop(said), "payout", said)
        for said in ("Bestell mir eine Pizza", "Öffne den Laden von Steam", "Wie läuft das Spiel?", "Wie läuft's?"):
            self.assertIsNone(match_shop(said), said)

    def test_only_georgs_shop_and_money(self):
        for said in ("Wie läuft der Online-Shop?", "Was hab ich heute verkauft?", "Was hat der Shop heute verkauft?"):
            self.assertEqual(match_shop(said), "summary", said)
        for said in ("Wann kommt das Geld vom Shop?", "Wann kommt mein Geld von Shopify?"):
            self.assertEqual(match_shop(said), "payout", said)
        # Das ist nicht Georgs Shop oder nicht das Geld aus dem Shop: das bekommt Claude.
        for said in ("Wann kommt das Geld von Max?", "Wann kommt mein Geld vom Finanzamt?", "Wann kommt mein Geld zurück?",
                     "Wie läuft der Shop von meinem Freund?", "Was verkauft Aldi diese Woche?"):
            self.assertIsNone(match_shop(said), said)


class ShopTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeShopify()
        self.fake.orders = [
            order(1, "2026-10-02T08:10:00Z", 29.0),
            order(2, "2026-10-02T11:30:00Z", 29.0, items=(("Mauspad Jarvis", 1), ("Sticker", 2))),
            order(3, "2026-09-30T18:00:00Z", 120.5, fulfillment="FULFILLED", items=(("Hoodie", 1),)),
            order(4, "2026-09-29T09:00:00Z", 25.0, fulfillment="FULFILLED"),
            order(5, "2026-10-01T09:00:00Z", 99.0, cancelled=True),
            order(6, "2026-10-01T09:30:00Z", 1.0, test=True),
            order(7, "2026-09-27T09:00:00Z", 50.0),  # letzte Woche
        ]

    def test_summary_today_week_open(self):
        summary = make_shop(self.fake).summary()
        self.assertEqual(summary["heute"], {"anzahl": 2, "umsatz": 58.0})
        self.assertEqual(summary["woche"], {"anzahl": 4, "umsatz": 203.5}, "ohne Storno, Test und letzte Woche")
        self.assertEqual(summary["offen"], 2)
        self.assertEqual(summary["bestseller"][0], ("Mauspad Jarvis", 3))
        self.assertEqual(spoken_summary(summary), "Heute 2 Bestellungen über 58 Euro, Sir. Diese Woche 4, zusammen "
                                                  "203,50 Euro. 2 warten noch auf den Versand. Am besten läuft Mauspad Jarvis.")
        token_calls = [c for c in self.fake.calls if c[0].endswith("access_token")]
        self.assertEqual(len(token_calls), 1, "Token wird wiederverwendet")
        self.assertIn("grant_type=client_credentials", token_calls[0][2])

    def test_quiet_day(self):
        self.fake.orders = []
        self.assertEqual(spoken_summary(make_shop(self.fake).summary()),
                         "Heute noch keine Bestellung, Sir. Diese Woche auch noch keine.")

    def test_payouts(self):
        payouts = make_shop(self.fake).payouts()
        self.assertEqual(spoken_payout(payouts, dt.date(2026, 10, 2)), "Die nächste Auszahlung kommt morgen, Sir: 112 Euro.")
        self.fake.payments = False
        with self.assertRaises(ShopError) as caught:
            make_shop(self.fake).payouts()
        self.assertEqual(caught.exception.kind, "payments")

    def test_draft_is_never_published(self):
        result = make_shop(self.fake).draft("Mauspad Jarvis", "Groß & griffig.\n\nFür lange Abende.", price=19.9,
                                            tags=["gaming"])
        self.assertEqual(result["status"], "DRAFT")
        self.assertEqual(result["link"], "https://admin.shopify.com/store/georg/products/555")
        create = json.loads([c for c in self.fake.calls if "productCreate" in c[2]][0][2])
        self.assertEqual(create["variables"]["product"]["descriptionHtml"], "<p>Groß &amp; griffig.</p><p>Für lange Abende.</p>")
        self.assertIn('"price": "19.90"', [c for c in self.fake.calls if "productVariantsBulkUpdate" in c[2]][0][2])
        self.assertFalse(any("publish" in c[2].lower() for c in self.fake.calls), "nie veröffentlichen")
        self.assertNotIn("write_publications", shopmod.SCOPES)

    def test_wrong_secret_and_throttling(self):
        shop = make_shop(self.fake)
        shop._secrets = Vault(shopify="falsch")
        with self.assertRaises(ShopError) as caught:
            shop.info()
        self.assertEqual(caught.exception.kind, "auth")
        self.fake.throttle = 1
        with mock.patch("jarvis.shop.time.sleep") as slept:
            self.assertEqual(make_shop(self.fake).info()["name"], "Georgs Laden")
        slept.assert_called_once()
        empty = Shop({"shop": {}}, Vault(), opener=self.fake)
        self.assertFalse(empty.configured)
        with self.assertRaises(ShopError) as caught:
            empty.summary()
        self.assertEqual(caught.exception.kind, "setup")

    def test_new_orders_are_announced_once(self):
        with tempfile.TemporaryDirectory() as folder:
            first = make_shop(self.fake, folder).new_orders()
            self.assertEqual(first, [], "beim ersten Mal nur den Stand merken")
            self.fake.orders.append(order(8, "2026-10-02T14:50:00Z", 34.0, items=(("Tasse", 2),)))
            fresh = make_shop(self.fake, folder).new_orders()
            self.assertEqual([o["name"] for o in fresh], ["#8"])
            self.assertEqual(spoken_order(fresh[0]), "Neue Bestellung im Shop, Sir: 34 Euro, 2 × Tasse.")
            self.assertEqual(make_shop(self.fake, folder).new_orders(), [], "nur einmal")


class AssistantShopTest(unittest.TestCase):
    def setUp(self):
        from tests.test_assistant import FakeBrain, make

        self.brain = FakeBrain()
        self.assistant, self.ui, self.speaker, _ = make(self.brain)
        self.assistant._disk_checked = float("inf")
        self.fake = FakeShopify()
        self.fake.orders = [order(1, "2026-10-02T08:10:00Z", 29.0)]

    def test_answers_without_claude(self):
        self.assistant.shop = make_shop(self.fake)
        self.assertEqual(self.assistant.handle("Wie läuft der Shop?"), "Heute eine Bestellung über 29 Euro, Sir. "
                                                                       "Eine wartet noch auf den Versand.")
        self.assertEqual(self.assistant.handle("Wann kommt die nächste Auszahlung?"),
                         "Die nächste Auszahlung kommt morgen, Sir: 112 Euro.")
        self.assertEqual(self.brain.asked, [])

    def test_not_connected_says_how(self):
        self.assistant.shop = Shop({"shop": {}}, Vault())
        self.assertIn("Verbinden", self.assistant.handle("Wie läuft der Shop?"))
        self.assertEqual(self.brain.asked, [])

    def test_new_orders_are_announced(self):
        with tempfile.TemporaryDirectory() as folder:
            self.assistant.shop = make_shop(self.fake, folder)
            self.assistant.check_shop()
            self.assertEqual(self.speaker.said, [])
            self.fake.orders.append(order(2, "2026-10-02T14:55:00Z", 19.9))
            with mock.patch.object(self.assistant, "_fullscreen", return_value=False):
                self.assistant.check_shop()
            self.assertEqual(self.speaker.said[-1], "Neue Bestellung im Shop, Sir: 19,90 Euro, Mauspad Jarvis.")


class ToolTest(unittest.TestCase):
    def test_tool_commands(self):
        from jarvis import tool

        fake = FakeShopify()
        fake.orders = [order(1, "2026-10-02T08:10:00Z", 29.0)]
        out = io.StringIO()
        with mock.patch.object(tool, "_shop", return_value=make_shop(fake)), redirect_stdout(out):
            self.assertEqual(tool.main(["shop"]), 0)
            self.assertEqual(tool.main(["shop-entwurf", "Mauspad Jarvis", "--preis", "19,90", "--text", "Griffig."]), 0)
            self.assertEqual(tool.main(["shop-entwurf", "x"]), 1)
        text = out.getvalue()
        self.assertIn("Heute eine Bestellung über 29 Euro", text)
        self.assertIn("Entwurf angelegt (für Kunden unsichtbar): Mauspad Jarvis", text)
        self.assertIn("https://admin.shopify.com/store/georg/products/555", text)


if __name__ == "__main__":
    unittest.main()
