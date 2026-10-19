import { BootSequence } from '@aegis/ui';
import { MotionConfig } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Home } from './Home.tsx';

/**
 * Wurzel der Desktop-App: zuerst die Start-Animation, darunter bereits eingehängt die
 * Startseite. Sie wird beim Ausblenden der Start-Ebene sichtbar, bleibt bis `onComplete`
 * aber `inert` und `aria-hidden` – erst danach ist sie bedienbar und bekommt den Fokus.
 */
export function App() {
  const [booted, setBooted] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (booted) {
      // Fokus in den freigegebenen Inhalt (erst jetzt möglich, vorher war er inert), damit
      // Tastatur- und Screenreader-Nutzer nicht am Dokumentanfang „verloren“ gehen.
      headingRef.current?.focus({ preventScroll: true });
    }
  }, [booted]);

  return (
    <MotionConfig reducedMotion="user">
      {!booted && <BootSequence onComplete={() => setBooted(true)} />}
      <Home ready={booted} headingRef={headingRef} />
    </MotionConfig>
  );
}
