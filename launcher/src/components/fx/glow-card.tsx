import type { KeyboardEvent, PointerEvent } from "react";
import { motion, type HTMLMotionProps } from "motion/react";
import { revealKinds, SPRING_UI, type RevealKind } from "@/lib/motion";
import { cn } from "@/lib/utils";

export interface GlowCardProps extends Omit<HTMLMotionProps<"div">, "variants"> {
  /** Clickable look: lifts 2 px on hover, soft violet glow, light follows the mouse, press feedback. */
  interactive?: boolean;
  /** Selected/active: brand-gradient hairline + brand glow. Use for one thing per screen. */
  glow?: boolean;
  /** Denser glass (for cards on top of other cards or over busy backgrounds). */
  strong?: boolean;
  /** Mouse-follow light without the lift (default: on when interactive). */
  spotlight?: boolean;
  /** How it appears inside PageShell/Stagger (default "up"). */
  kind?: RevealKind;
  /** Animate on its own (not inside PageShell/Stagger). */
  standalone?: boolean;
}

/**
 * The standard card: glass, 12 px radius, 1 px gradient hairline. No padding – add your own (p-5/p-6).
 * Takes part in the staggered page reveal automatically.
 */
export function GlowCard({
  interactive = false,
  glow = false,
  strong = false,
  spotlight,
  kind = "up",
  standalone = false,
  className,
  onPointerMove,
  onKeyDown,
  onClick,
  ...props
}: GlowCardProps) {
  const light = spotlight ?? interactive;
  const own = standalone ? { initial: "hidden", animate: "show" } : {};

  const handleMove = (e: PointerEvent<HTMLDivElement>) => {
    if (light) {
      const r = e.currentTarget.getBoundingClientRect();
      e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
      e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
    }
    onPointerMove?.(e);
  };

  // Clickable cards can also be used with the keyboard
  const clickable = interactive && onClick;
  const handleKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (clickable && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      e.currentTarget.click();
    }
    onKeyDown?.(e);
  };

  return (
    <motion.div
      variants={revealKinds[kind]}
      {...own}
      whileHover={interactive ? { y: -2 } : undefined}
      whileTap={interactive ? { scale: 0.99 } : undefined}
      transition={SPRING_UI}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={handleKey}
      onPointerMove={handleMove}
      className={cn(
        strong ? "glass-strong" : "glass",
        "rounded-xl",
        light && "spotlight",
        interactive && "group hover-glow focus-ring cursor-pointer",
        glow && "gradient-border-brand glow-primary",
        className,
      )}
      {...props}
    />
  );
}
