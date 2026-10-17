// PLACEHOLDER – Installation. A feature agent replaces this module (keep the contract).
import '../styles/screens/install.css';
import { stubScreen } from './_stub.js';

export default {
  title: 'Installation',
  fxState: 'installing',
  mount(container, ctx) {
    container.classList.add('screen--install');
    return stubScreen(container, ctx, {
      name: 'install',
      icon: 'rocket',
      eyebrow: 'Schritt 3 von 3',
      title: 'Wird installiert.',
      lead: 'PHOENIX prüft winget, fragt einmal nach Administratorrechten und installiert alles nacheinander – still im Hintergrund, mit Live-Fortschritt.',
      upcoming: [
        'Großer Fortschrittsring mit Restzeit',
        'Live-Liste: Download, Installation, Ergebnis',
        'Einmalige Windows-Abfrage (UAC)',
        'Abbrechen jederzeit möglich'
      ],
    });
  },
};
