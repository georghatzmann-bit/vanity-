// PLACEHOLDER – Auswahl. A feature agent replaces this module (keep the contract).
import '../styles/screens/select.css';
import { stubScreen } from './_stub.js';

export default {
  title: 'Auswahl',
  fxState: 'home',
  mount(container, ctx) {
    container.classList.add('screen--select');
    return stubScreen(container, ctx, {
      name: 'select',
      icon: 'grid',
      eyebrow: 'Schritt 2 von 3',
      title: 'Was soll zurück?',
      lead: 'Alle Apps aus deinem Profil nach Kategorie sortiert. Suchen, alles an- oder abwählen und Vorschläge aus dem Katalog hinzufügen.',
      upcoming: [
        'App-Kacheln mit Icon, Beschreibung und Auswahl',
        'Suche und Kategorien mit „alle/keine“',
        'Voreinstellungen wie „Gaming-Basics“',
        'Zusammenfassung mit Downloadgröße'
      ],
    });
  },
};
