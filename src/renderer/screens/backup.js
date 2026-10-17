// PLACEHOLDER – Sichern. A feature agent replaces this module (keep the contract).
import '../styles/screens/backup.css';
import { stubScreen } from './_stub.js';

export default {
  title: 'Sichern',
  fxState: 'scan',
  mount(container, ctx) {
    container.classList.add('screen--backup');
    return stubScreen(container, ctx, {
      name: 'backup',
      icon: 'shield',
      eyebrow: 'Vor dem Reset',
      title: 'Alles sichern.',
      lead: 'PHOENIX scannt deine Apps, Spiele und Hardware und legt ein Profil an – auf USB-Stick, zweiter Festplatte, OneDrive oder als Wiederherstellungs-Code.',
      upcoming: [
        'Automatischer Scan mit Live-Fortschritt',
        'Übersicht: Apps, Spiele und „manuell installieren“-Liste',
        'Speicherziele: USB-Stick, Festplatte, OneDrive, Code',
        'Abschluss-Checkliste vor dem Reset'
      ],
    });
  },
};
