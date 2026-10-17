// PLACEHOLDER – Wiederherstellen. A feature agent replaces this module (keep the contract).
import '../styles/screens/restore.css';
import { stubScreen } from './_stub.js';

export default {
  title: 'Wiederherstellen',
  fxState: 'home',
  mount(container, ctx) {
    container.classList.add('screen--restore');
    return stubScreen(container, ctx, {
      name: 'restore',
      icon: 'download',
      eyebrow: 'Nach dem Reset',
      title: 'Willkommen zurück.',
      lead: 'PHOENIX findet dein Profil automatisch auf allen Laufwerken. Alternativ öffnest du eine Datei, fügst deinen Code ein oder startest mit dem Schnell-Setup.',
      upcoming: [
        'Gefundene Profile als Karten mit Datum und Anzahl',
        'Profil-Datei öffnen oder winget-Export laden',
        'Wiederherstellungs-Code einfügen',
        'Schnell-Setup mit beliebten Apps'
      ],
    });
  },
};
