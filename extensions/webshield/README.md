# extensions/webshield – AEGIS Web-Schutz

Browser-Erweiterung für Edge und Chrome (Manifest V3, `declarativeNetRequest`). Entscheidung:
`docs/DECISIONS.md` D-050, Sicherheit: `docs/SECURITY.md`.

- **Sperrlisten:** gebündelt `public/rules/bundled.json` (Block List Project ransomware + scam);
  täglich nachgeladen (abschaltbar) Phishing.Database und Block List Project phishing + fraud
  (`src/lib/sources.ts`). Treffer leiten Hauptseiten auf `warn.html` um.
- **Warnseite:** „Trotzdem öffnen“ erst nach Häkchen, gilt nur für diesen Host in dieser Sitzung.
- **Hinweise:** Markenname in fremder Domain, Punycode, Passwortfeld ohne HTTPS (Banner);
  riskante Downloads (Benachrichtigung – nichts wird abgebrochen oder gelöscht).

```bash
pnpm --filter @aegis/webshield build        # dist/ (entpackt ladbar)
pnpm --filter @aegis/webshield test         # Unit-Tests
pnpm --filter @aegis/webshield test:e2e     # Chromium mit geladener Erweiterung
pnpm --filter @aegis/webshield update-lists # bundled.json neu erzeugen
```

Installieren (bis zur Store-Veröffentlichung): `edge://extensions` → Entwicklermodus →
„Entpackt laden“ → `dist/`.
