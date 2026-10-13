import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import "@fontsource-variable/inter";
import "@fontsource-variable/sora";
import "./styles.css";
import { App } from "./App";
import { prefersReducedMotion } from "@shared/lib/env";

// Rechtsklick-Menü des Browsers im Installer ausblenden
window.addEventListener("contextmenu", (e) => {
  if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MotionConfig reducedMotion={prefersReducedMotion() ? "always" : "never"}>
      <App />
    </MotionConfig>
  </StrictMode>,
);
