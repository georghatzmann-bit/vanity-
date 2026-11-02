'use strict';
// "Virus-Reset": a clean Windows reinstall after malware. The steps before the reset have actions in
// the UI; everything after it is also written as an offline HTML page next to the backup, so it can
// be read on the stick or the phone once the old Windows is gone.
const fs = require('fs');
const path = require('path');

const LINKS = {
  windows: 'https://www.microsoft.com/de-de/software-download/windows11',
  rufus: 'https://rufus.ie/de/',
};

const STEPS = [
  {
    id: 'backup', phase: 'before', title: 'Sicherung machen – nur die App-Liste',
    text: 'Phoenix sichert nur die Liste deiner Apps und Einstellungen, keine Programme oder Dateien. So schleppst du nichts Infiziertes mit. Eigene Dateien (Fotos, Dokumente) nur kopieren, wenn du sie brauchst – und keine .exe-, .bat-, .scr- oder Office-Dateien mit Makros vom alten PC übernehmen.',
    action: 'backup',
  },
  {
    id: 'iso', phase: 'before', title: 'Windows 11 herunterladen',
    text: 'Auf der offiziellen Microsoft-Seite die aktuelle Windows-11-ISO (24H2 / 25H2) laden. Am besten an einem anderen, sauberen Gerät – oder hier, wenn das der einzige PC ist.',
    action: 'link:windows',
  },
  {
    id: 'usb', phase: 'before', title: 'Boot-Stick erstellen',
    text: 'Mit Rufus die ISO auf einen USB-Stick schreiben (mindestens 8 GB). Achtung: Rufus löscht diesen Stick komplett. Deine Phoenix-Sicherung und diese Anleitung gehören auf einen ZWEITEN Stick oder aufs Handy (Wiederherstellungs-Code).',
    action: 'link:rufus',
  },
  {
    id: 'save', phase: 'before', title: 'Anleitung auf den zweiten Stick legen',
    text: 'Nach dem Reset gibt es Phoenix erst wieder, wenn du es vom Stick startest. Die Anleitung liegt deshalb zusätzlich als Datei „Phoenix-Virus-Reset.html“ im Phoenix-Ordner auf dem Stick – öffnet sich auch auf dem Handy.',
    action: 'save',
  },
  {
    id: 'unplug', phase: 'install', title: 'Andere Laufwerke abstecken',
    text: 'Zweite SSDs/Festplatten mit Daten, die du behalten willst, vor der Installation abstecken (oder im Setup sehr genau hinschauen). So löschst du nicht aus Versehen das falsche Laufwerk.',
  },
  {
    id: 'boot', phase: 'install', title: 'Vom Stick starten',
    text: 'Boot-Stick einstecken, PC neu starten und das Boot-Menü öffnen (meist F8, F11, F12 oder Entf – steht kurz beim Start oder im Handbuch des Mainboards). Den USB-Stick auswählen.',
  },
  {
    id: 'clean', phase: 'install', title: 'Sauber installieren – alle Partitionen der Systemplatte löschen',
    text: '„Benutzerdefiniert: nur Windows installieren“ wählen. Auf der Systemplatte jede Partition einzeln löschen, bis nur „Nicht zugewiesener Speicherplatz“ übrig ist. Den auswählen und „Weiter“ – Windows legt die Partitionen selbst an. So verschwinden auch Reste im alten Bootloader.',
  },
  {
    id: 'account', phase: 'install', title: 'Konto einrichten',
    text: 'Microsoft-Konto oder lokales Konto – beides ist in Ordnung. Für ein lokales Konto: Internet trennen, bevor die Kontoseite kommt, und „Ich habe kein Internet“ wählen. Fehlt die Option, mit Umschalt+F10 die Eingabeaufforderung öffnen und je nach Windows-Version „start ms-cxh:localonly“ oder „OOBE\\BYPASSNRO“ eingeben. Wenn du mit dem Microsoft-Konto anmeldest: vorher das Passwort ändern (Schritt 9 zuerst an einem sauberen Gerät).',
  },
  {
    id: 'passwords', phase: 'after', title: 'Passwörter ändern – an einem sauberen Gerät',
    text: 'Malware stiehlt oft gespeicherte Passwörter und Login-Cookies. Am Handy oder einem anderen PC zuerst das E-Mail-Passwort ändern, dann Microsoft, Discord, Epic, Steam, Riot, Google, Banking. Überall „Von allen Geräten abmelden“ und Zwei-Faktor-Anmeldung einschalten.',
  },
  {
    id: 'update', phase: 'after', title: 'Windows Update & Treiber',
    text: 'Einstellungen → Windows Update so oft ausführen, bis nichts mehr kommt (auch „Optionale Updates“ für Treiber). Grafiktreiber vom Hersteller (Phoenix zeigt dir den richtigen).',
  },
  {
    id: 'security', phase: 'after', title: 'Schutz eingeschaltet lassen',
    text: 'Windows-Sicherheit muss überall grün sein. TPM, Secure Boot und die Kernisolierung (Speicher-Integrität) eingeschaltet lassen – sie machen es Malware deutlich schwerer, sich wieder festzusetzen. Valorant/Vanguard und viele Anti-Cheats brauchen sie sowieso.',
  },
  {
    id: 'restore', phase: 'after', title: 'Phoenix starten und wiederherstellen',
    text: 'Phoenix-Setup vom zweiten Stick starten → „Wiederherstellen“ → deine Sicherung wählen. Phoenix lädt alle Apps frisch von den Herstellern, nichts vom alten PC. Am Ende „Monitore & Einstellungen“.',
  },
  {
    id: 'sticks', phase: 'after', title: 'Alte Sticks und Dateien prüfen',
    text: 'Bevor du Dateien vom alten PC öffnest: Stick einstecken, Rechtsklick → „Mit Microsoft Defender überprüfen“. Programme nie vom alten Stick starten, sondern neu herunterladen.',
  },
];

const PHASES = { before: 'Vor dem Reset – macht Phoenix mit dir', install: 'Die Installation', after: 'Nach dem Reset' };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function toHtml() {
  let n = 0;
  const sections = Object.entries(PHASES)
    .map(([phase, title]) => {
      const items = STEPS.filter((s) => s.phase === phase)
        .map((s) => {
          n += 1;
          const link = s.action && s.action.startsWith('link:') ? `<p><a href="${LINKS[s.action.slice(5)]}">${LINKS[s.action.slice(5)]}</a></p>` : '';
          return `<li><span class="n">${n}</span><div><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p>${link}</div></li>`;
        })
        .join('');
      return `<h2>${esc(title)}</h2><ol>${items}</ol>`;
    })
    .join('');
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Phoenix · Virus-Reset</title><style>
:root{color-scheme:dark}body{margin:0;background:#0b0912;color:#ece9f5;font:16px/1.55 system-ui,Segoe UI,sans-serif}main{max-width:760px;margin:0 auto;padding:28px 16px 60px}
h1{font-size:28px;margin:0 0 6px}h1 span{color:#a78bfa}.lead{color:#a9a3bd;margin:0 0 24px}h2{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#a78bfa;margin:32px 0 12px}
ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px}li{display:flex;gap:14px;padding:16px;border:1px solid #2a2440;border-radius:14px;background:#141022}
.n{flex:none;display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:#7c3aed;font-weight:700}h3{margin:2px 0 6px;font-size:17px}p{margin:0 0 6px;color:#cfc9e0}a{color:#c4b5fd;word-break:break-all}
</style></head><body><main><h1>Phoenix · <span>Virus-Reset</span></h1><p class="lead">Saubere Neuinstallation von Windows 11 nach einem Virus. Diese Seite funktioniert offline – auch auf dem Handy.</p>${sections}</main></body></html>`;
}

/** Writes the guide to <root>\Phoenix\Phoenix-Virus-Reset.html (root = drive like "E:\" or, off Windows, a folder). */
function saveGuide(root) {
  if (!/^[A-Za-z]:\\?$/.test(root) && !(process.platform !== 'win32' && path.isAbsolute(root))) throw new Error('Ungültiges Laufwerk.');
  const base = /^[A-Za-z]:$/.test(root) ? `${root}\\` : root;
  const dir = path.join(base, 'Phoenix');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'Phoenix-Virus-Reset.html');
  fs.writeFileSync(file, toHtml(), 'utf8');
  return { path: file };
}

function getGuide() {
  return { steps: STEPS.map(({ id, phase, title, text, action }) => ({ id, phase, title, text, action: action || null })), phases: PHASES, links: LINKS };
}

module.exports = { STEPS, LINKS, getGuide, toHtml, saveGuide };
