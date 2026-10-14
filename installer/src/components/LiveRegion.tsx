/**
 * Unsichtbare Ansage (H): polite, sr-only. Andere Teile melden über `announce(text)`.
 */
import { useEffect, useState } from "react";

const subs = new Set<(text: string) => void>();

/** Text höflich ansagen (Phasenwechsel, 10-%-Schritte, „Signal steht.“ …) */
export function announce(text: string) {
  subs.forEach((s) => s(text));
}

export function LiveRegion() {
  const [msg, setMsg] = useState({ text: "", n: 0 });
  useEffect(() => {
    const sub = (text: string) => setMsg((m) => ({ text, n: m.n + 1 }));
    subs.add(sub);
    return () => {
      subs.delete(sub);
    };
  }, []);
  return (
    <div className="obs-sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="live-region">
      {/* Schlüssel wechselt, damit gleiche Texte erneut angesagt werden */}
      <span key={msg.n}>{msg.text}</span>
    </div>
  );
}
