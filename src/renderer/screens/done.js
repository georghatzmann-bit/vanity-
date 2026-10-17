// PLACEHOLDER – Fertig. A feature agent replaces this module (keep the contract).
import '../styles/screens/done.css';
import { stubScreen } from './_stub.js';

export default {
  title: 'Fertig',
  fxState: 'success',
  mount(container, ctx) {
    container.classList.add('screen--done');
    return stubScreen(container, ctx, {
      name: 'done',
      icon: 'check-circle',
      eyebrow: 'Abgeschlossen',
      title: 'Geschafft.',
      lead: 'Zusammenfassung aller Installationen, fehlgeschlagene erneut versuchen, Neustart-Hinweis und Log exportieren.',
      upcoming: [
        'Ergebnis mit installiert, übersprungen und fehlgeschlagen',
        'Fehlgeschlagene erneut versuchen',
        'Hinweis, wenn ein Neustart nötig ist',
        'Log für den Support exportieren'
      ],
    });
  },
};
