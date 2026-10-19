import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@aegis/ui/styles.css';
import './styles.css';
import { App } from './App.tsx';
import { createAppServices } from './app/createServices.ts';
import { applyDocumentPreferences, resolvePreferences } from './settings/preferences.ts';
import { systemColorScheme, systemLanguages } from './settings/system.ts';

const services = createAppServices({ window });

// Darstellung, Sprache und Bewegung schon vor dem ersten Zeichnen setzen (kein Aufblitzen).
applyDocumentPreferences(
  document.documentElement,
  resolvePreferences(services.settings.getSnapshot().settings, {
    colorScheme: systemColorScheme(),
    languages: systemLanguages(),
    reducedMotion: services.motion.systemPrefersReduced(),
  }),
);

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App services={services} />
    </StrictMode>,
  );
}
