import { memo } from "react";
import { genCoverSpec, initials } from "@/lib/gencover";
import { imgSrc } from "@/lib/api";
import { cn } from "@shared/lib/cn";

/**
 * Generiertes Kunst-Cover für Einträge ohne Bild: Farben, Muster und Typografie
 * werden stabil aus dem Namen abgeleitet - jedes Spiel sieht anders aus, nie leer.
 */
/** Quadratisches Kunst-Icon (Dock, Overlay) */
export const GenIcon = memo(function GenIcon({ name, className }: { name: string; className?: string }) {
  const s = genCoverSpec(name);
  return (
    <div className={cn("@container relative grid h-full w-full place-items-center overflow-hidden", className)} style={{ background: `linear-gradient(${s.angle}deg, ${s.colors.glow} -20%, ${s.colors.a} 40%, ${s.colors.deep} 100%)` }}>
      <div className="absolute -top-1/3 -left-1/4 h-full w-full rounded-full opacity-60 blur-md" style={{ background: `radial-gradient(circle, ${s.colors.glow}, transparent 60%)` }} />
      <span className="relative font-display font-bold tracking-tight text-white [text-shadow:0_2px_8px_rgb(0_0_0/0.35)]" style={{ fontSize: initials(name).length > 2 ? "30cqw" : "38cqw" }}>
        {initials(name)}
      </span>
    </div>
  );
});

export const GenCover = memo(function GenCover({ name, kind, icon, landscape, className }: { name: string; kind: "game" | "app"; icon?: string; landscape?: boolean; className?: string }) {
  const s = genCoverSpec(name);
  const { a, b, c, glow, deep } = s.colors;
  const pid = `gp${s.hue}${s.pattern}${name.length}`;
  return (
    <div
      className={cn("@container relative h-full w-full overflow-hidden", className)}
      style={{ background: `linear-gradient(${s.angle}deg, ${a} 0%, ${b} 62%, ${deep} 100%)` }}
    >
      {/* Lichtflecken */}
      <div className="absolute -top-[20%] -left-[25%] h-[75%] w-[90%] rounded-full opacity-70 blur-2xl" style={{ background: `radial-gradient(circle, ${glow} 0%, transparent 65%)` }} />
      <div className="absolute -right-[30%] -bottom-[15%] h-[70%] w-[90%] rounded-full opacity-45 blur-2xl" style={{ background: `radial-gradient(circle, ${c} 0%, transparent 65%)` }} />

      {/* Muster */}
      <svg className="absolute inset-0 h-full w-full opacity-[0.22] mix-blend-screen" viewBox="0 0 300 450" preserveAspectRatio="xMidYMid slice" aria-hidden>
        <defs>
          <pattern id={pid} width="22" height="22" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r="1.2" fill="white" />
          </pattern>
        </defs>
        {s.pattern === 0 &&
          [0, 1, 2, 3, 4, 5].map((i) => <ellipse key={i} cx="150" cy="190" rx={40 + i * 34} ry={14 + i * 12} fill="none" stroke="white" strokeWidth="1.1" transform={`rotate(-22 150 190)`} opacity={1 - i * 0.12} />)}
        {s.pattern === 1 &&
          [0, 1, 2, 3, 4, 5, 6, 7].map((i) => <path key={i} d={`M-20 ${120 + i * 26} C 60 ${90 + i * 26}, 120 ${170 + i * 26}, 180 ${130 + i * 26} S 280 ${100 + i * 26}, 330 ${140 + i * 26}`} fill="none" stroke="white" strokeWidth="1.1" opacity={0.9 - i * 0.08} />)}
        {s.pattern === 2 && <rect width="300" height="450" fill={`url(#${pid})`} />}
        {s.pattern === 3 &&
          [
            [80, 120, 34],
            [220, 210, 22],
            [130, 300, 14],
            [240, 90, 10],
          ].map(([x, y, r], i) => <path key={i} d={`M${x} ${y - r * 2} C ${x + r * 0.2} ${y - r * 0.2}, ${x + r * 0.2} ${y - r * 0.2}, ${x + r * 2} ${y} C ${x + r * 0.2} ${y + r * 0.2}, ${x + r * 0.2} ${y + r * 0.2}, ${x} ${y + r * 2} C ${x - r * 0.2} ${y + r * 0.2}, ${x - r * 0.2} ${y + r * 0.2}, ${x - r * 2} ${y} C ${x - r * 0.2} ${y - r * 0.2}, ${x - r * 0.2} ${y - r * 0.2}, ${x} ${y - r * 2} Z`} fill="white" opacity={0.9 - i * 0.15} />)}
      </svg>

      {/* Icon (Programme) oder Monogramm */}
      {icon ? (
        <div className="absolute inset-0 grid place-items-center pb-[18%]">
          <img src={imgSrc(icon)} alt="" className="h-[38cqw] w-[38cqw] object-contain drop-shadow-[0_10px_24px_rgb(0_0_0/0.45)]" draggable={false} />
        </div>
      ) : (
        !landscape && (
          <div className="absolute top-[14%] left-0 w-full text-center font-display leading-none font-bold tracking-tight text-white/[0.13] @max-[110px]:top-[30%] @max-[110px]:text-white/80" style={{ fontSize: "34cqw" }}>
            {initials(name)}
          </div>
        )
      )}

      {/* Titel (im Querformat zeigt die Seite den Titel selbst) */}
      {!landscape && (
      <div className="absolute inset-x-0 bottom-0 p-[8cqw] pt-[22cqw] @max-[110px]:hidden" style={{ background: `linear-gradient(to top, ${deep}e6, transparent)` }}>
        <div className="mb-[2.5cqw] text-[max(9px,4.6cqw)] font-semibold tracking-[0.22em] text-white/60 uppercase">{kind === "app" ? "App" : "Game"}</div>
        <div className="line-clamp-3 font-display font-bold tracking-tight text-white [text-shadow:0_2px_12px_rgb(0_0_0/0.35)]" style={{ fontSize: "max(12px, 10.5cqw)", lineHeight: 1.05 }}>
          {name}
        </div>
      </div>
      )}
    </div>
  );
});
