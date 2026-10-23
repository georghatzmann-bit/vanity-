/** Hintergrund hinter allen Glas-Flächen: treibende Farbflächen + feines Punktraster. */
export function Background() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <div className="aurora">
        <span />
        <span />
        <span />
      </div>
      <div className="dot-grid" />
      {/* Abdunkeln unten, damit Text auf Glas gut lesbar bleibt */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-background/30 to-background/80" />
    </div>
  );
}
