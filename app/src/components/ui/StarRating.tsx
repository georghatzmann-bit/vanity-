import { useState } from "react";
import { motion } from "motion/react";
import { Star } from "lucide-react";
import { cn } from "@shared/lib/cn";
import { sound } from "@shared/sound/engine";

/** Sterne-Bewertung mit halben Sternen und federnder Animation */
export function StarRating({ value, onChange, size = 22, readOnly }: { value: number; onChange?: (v: number) => void; size?: number; readOnly?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value;
  return (
    <div className="inline-flex items-center gap-0.5" onMouseLeave={() => setHover(null)}>
      {[1, 2, 3, 4, 5].map((i) => {
        const fill = Math.max(0, Math.min(1, shown - (i - 1)));
        return (
          <motion.button
            key={i}
            type="button"
            disabled={readOnly}
            whileHover={readOnly ? undefined : { scale: 1.2, rotate: -8 }}
            whileTap={readOnly ? undefined : { scale: 0.85 }}
            className={cn("relative", readOnly ? "cursor-default" : "cursor-pointer")}
            style={{ width: size, height: size }}
            onMouseMove={(e) => {
              if (readOnly) return;
              const r = e.currentTarget.getBoundingClientRect();
              const half = e.clientX - r.left < r.width / 2;
              const v = half ? i - 0.5 : i;
              if (v !== hover) {
                setHover(v);
                sound.play("tick");
              }
            }}
            onClick={() => {
              if (readOnly || hover === null) return;
              const v = hover === value ? 0 : hover;
              sound.play(v > value ? "toggleOn" : "toggleOff");
              onChange?.(v);
            }}
            aria-label={`${i}`}
          >
            <Star className="absolute inset-0 text-faint" style={{ width: size, height: size }} strokeWidth={1.6} />
            <span className="absolute inset-0 overflow-hidden" style={{ width: `${fill * 100}%` }}>
              <Star className="text-warning" style={{ width: size, height: size, filter: "drop-shadow(0 0 6px color-mix(in oklab, var(--nv-warning) 60%, transparent))" }} fill="currentColor" strokeWidth={1.6} />
            </span>
          </motion.button>
        );
      })}
    </div>
  );
}
