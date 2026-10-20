# apps/browser – AEGIS Browser (P12)

Privacy-Browser als eigenes Tauri-Fenster: oben die Leiste (diese React-App), darunter je Tab
ein WebView (WebView2 unter Windows). Webseiten bekommen keinerlei App-Rechte – die Capability
gilt nur für die Leiste (`chrome-*`).

- **Tracker-Blocker:** EasyList/EasyPrivacy, nur auf Wunsch geladen (eigene Lizenzen,
  nicht mitgeliefert); geprüft wird jede Anfrage in WebView2 (`aegis_winffi::webview`).
- **HTTPS-only:** `http` wird angehoben; HTTP nur nach ausdrücklicher Erlaubnis je Sitzung.
- **DNS-over-HTTPS:** Quad9 (Standard), Mullvad, Cloudflare oder aus.
- **Ghost-Modus:** InPrivate-Fenster; optional über einen laufenden Tor-/Arti-SOCKS-Proxy
  (Port 9150/9050). Ehrlich: Der offizielle Tor Browser ist stärker.

```bash
pnpm --filter @aegis/browser tauri dev
```
