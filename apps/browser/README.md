# apps/browser – AEGIS Browser (P12)

Privacy-Browser als eigenes Tauri-Fenster: oben die Leiste (diese React-App), darunter je Tab
ein WebView (WebView2 unter Windows). Webseiten bekommen keinerlei App-Rechte – die Capability
gilt nur für die Leiste (`chrome-*`).

- **Tracker-Blocker:** EasyList/EasyPrivacy, nur auf Wunsch geladen (eigene Lizenzen,
  nicht mitgeliefert); geprüft wird jede Anfrage in WebView2 (`aegis_winffi::webview`) –
  Seiten, iframes und Worker; eingehängt, bevor die erste Seite lädt.
- **HTTPS-only:** `http` wird angehoben; HTTP nur nach ausdrücklicher Erlaubnis je Host und
  Sitzung (Ghost-Fenster je Fenster). Eingebettete Seiten nur Web-/Inhalts-Adressen, externe
  Programme (`ms-msdt:` …) startet der Browser nie.
- **DNS:** über Windows (DoH dort ab Windows 11 einstellbar); WebView2 hat keinen DoH-Schalter.
- **Ghost-Modus:** InPrivate-Fenster; optional über einen laufenden SOCKS5-Proxy (Tor/Arti,
  Port 9150/9050) – alles samt DNS über den Proxy. Ehrlich: Der offizielle Tor Browser ist
  stärker, und Seiten erkennen ein WebView2-Fenster einer App.

```bash
pnpm --filter @aegis/browser tauri dev
```
