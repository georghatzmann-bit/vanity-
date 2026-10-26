import type { ReactNode } from "react";
import { motion, type HTMLMotionProps } from "motion/react";
import { Loader2 } from "lucide-react";
import { useCalmMotion } from "@/hooks/use-calm-motion";
import { SPRING_UI } from "@/lib/motion";
import { cn } from "@/lib/utils";

export interface ShimmerButtonProps extends Omit<HTMLMotionProps<"button">, "children"> {
  children: ReactNode;
  /** Icon in front of the text (e.g. <Play className="fill-current" />). */
  icon?: ReactNode;
  /** md = 40 px, lg = 48 px (default), xl = 56 px tall. */
  size?: "md" | "lg" | "xl";
  /** "brand" = gradient call to action. "neutral" = dark glass (e.g. "Stop"). */
  tone?: "brand" | "neutral";
  /** Slow breathing glow halo – only for the one idle call to action on a screen. */
  pulse?: boolean;
  /** Shows a spinner instead of the icon. */
  loading?: boolean;
  /** Play the sheen sweep once when it appears (default true). It always sweeps on hover. */
  sheenOnMount?: boolean;
}

const sizes = {
  md: "h-10 px-5 text-sm gap-2 rounded-lg [&_svg]:size-4",
  lg: "h-12 px-7 text-[15px] gap-2.5 rounded-xl [&_svg]:size-5",
  xl: "h-14 px-9 text-base gap-3 rounded-xl [&_svg]:size-5",
};

/** The big hero button ("Host & Play", "Let's go"): brand gradient, sheen sweep, glow, press feedback. */
export function ShimmerButton({
  children,
  icon,
  size = "lg",
  tone = "brand",
  pulse = false,
  loading = false,
  sheenOnMount = true,
  disabled,
  className,
  type = "button",
  ...props
}: ShimmerButtonProps) {
  const calm = useCalmMotion();
  const brand = tone === "brand";
  return (
    <motion.button
      type={type}
      disabled={disabled}
      whileHover={disabled ? undefined : { y: -1, scale: 1.015 }}
      whileTap={disabled ? undefined : { scale: 0.97 }}
      transition={SPRING_UI}
      className={cn(
        "group relative isolate inline-flex shrink-0 cursor-pointer items-center justify-center font-semibold whitespace-nowrap select-none focus-ring",
        "disabled:cursor-not-allowed disabled:opacity-45 disabled:saturate-50",
        brand ? "text-white" : "text-foreground",
        sizes[size],
        className,
      )}
      {...props}
    >
      {/* breathing halo */}
      {brand && pulse && !disabled && !calm && (
        <span
          aria-hidden
          className="nb-loop pointer-events-none absolute -inset-1.5 -z-20 rounded-[inherit] bg-brand opacity-60 blur-xl animate-breathe"
        />
      )}
      {/* fill */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 -z-10 rounded-[inherit] transition-shadow duration-200",
          brand
            ? "bg-brand shadow-[inset_0_1px_0_rgb(255_255_255/0.28),inset_0_0_0_1px_rgb(255_255_255/0.12),0_10px_30px_-10px_rgb(139_92_246/0.7)] group-hover:shadow-[inset_0_1px_0_rgb(255_255_255/0.3),inset_0_0_0_1px_rgb(255_255_255/0.16),0_14px_40px_-10px_rgb(139_92_246/0.85)]"
            : "glass-strong",
        )}
      />
      {/* cyan tip on hover (hero moment) */}
      {brand && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 rounded-[inherit] bg-brand-shine opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-disabled:opacity-0"
        />
      )}
      {/* sheen sweep */}
      <span aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]">
        <span className={cn("sheen", sheenOnMount && !calm && "sheen-once")} />
      </span>
      <span className="relative inline-flex items-center gap-[inherit]">
        {loading ? <Loader2 className="animate-spin" /> : icon}
        {children}
      </span>
    </motion.button>
  );
}
