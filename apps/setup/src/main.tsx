import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@aegis/ui/styles.css';
import './styles.css';
import { App } from './App.tsx';
import { tauriApi } from './api.ts';
import { lang } from './texts.ts';

const root = document.getElementById('root');
if (root) {
  void tauriApi().then((api) => {
    createRoot(root).render(
      <StrictMode>
        <App api={api} lang={lang(navigator.languages)} />
      </StrictMode>,
    );
  });
}
