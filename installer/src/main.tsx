import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import "@fontsource-variable/inter/opsz.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./styles.css";
import { App } from "./App";
import { forcedReducedMotion } from "./hooks/useReducedMotion";
import { sound } from "@shared/sound/engine";

// Klanglabor (E.9): nur im Dev-Server mit ?lab, im Build entfernt
const lab = import.meta.env.DEV && new URLSearchParams(location.search).has("lab");
const SoundLab = lab ? lazy(() => import("./lab/SoundLab")) : null;

// Rechtsklick-Menü des Browsers im Installer ausblenden
window.addEventListener("contextmenu", (e) => {
  if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
});

// Installer startet mit halber Lautstärke (J.3); Kontext früh vorbereiten
sound.setVolume(0.5);
sound.warmup();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionConfig reducedMotion={forcedReducedMotion() ? "always" : "user"}>
      {SoundLab ? (
        <Suspense fallback={null}>
          <SoundLab />
        </Suspense>
      ) : (
        <App />
      )}
    </MotionConfig>
  </StrictMode>,
);
