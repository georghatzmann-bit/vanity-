// PLACEHOLDER – Spiele. A feature agent replaces this module (keep the contract).
import '../styles/screens/games.css';
import { stubScreen } from './_stub.js';

export default {
  title: 'Spiele',
  fxState: 'home',
  mount(container, ctx) {
    container.classList.add('screen--games');
    return stubScreen(container, ctx, {
      name: 'games',
      icon: 'gamepad',
      eyebrow: 'Deine Bibliothek',
      title: 'Zurück ins Spiel.',
      lead: 'Für jedes Spiel aus deinem Profil öffnet PHOENIX direkt die Installationsseite im passenden Launcher – sobald Epic oder Steam bereit sind.',
      upcoming: [
        'Spielekarten mit Plattform und Größe',
        'Ein Klick öffnet Epic Games oder Steam',
        'Hinweis, wenn der Launcher noch fehlt',
        'Fortnite, Rocket League, CS2 und mehr'
      ],
    });
  },
};
