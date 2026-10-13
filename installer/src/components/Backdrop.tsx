import { forwardRef } from "react";
import { Starfield, type StarfieldHandle } from "@shared/ui/Starfield";

/** Hintergrund des Installers: Sternenhimmel, Radar-Raster, langsames Farbglühen, Filmkorn */
export const Backdrop = forwardRef<StarfieldHandle>(function Backdrop(_, ref) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -top-1/3 -left-1/4 h-[90%] w-[70%] rounded-full blur-[90px]" style={{ background: "radial-gradient(circle, var(--nv-glow-a), transparent 70%)", animation: "nv-aurora 20s ease-in-out infinite" }} />
      <div className="absolute -right-1/4 -bottom-1/3 h-[90%] w-[70%] rounded-full blur-[100px]" style={{ background: "radial-gradient(circle, var(--nv-glow-b), transparent 70%)", animation: "nv-aurora 26s ease-in-out infinite reverse" }} />
      <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: "linear-gradient(var(--nv-fg) 1px, transparent 1px), linear-gradient(90deg, var(--nv-fg) 1px, transparent 1px)", backgroundSize: "44px 44px", maskImage: "radial-gradient(70% 70% at 50% 50%, black 20%, transparent 100%)" }} />
      <Starfield ref={ref} className="absolute inset-0" density={1.3} drift={0.6} />
      <div className="noise absolute inset-0" />
    </div>
  );
});
