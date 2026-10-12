import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { motion } from "motion/react";
import { Loader2 } from "lucide-react";
import { cn } from "../lib/cn";
import { spring } from "../design/motion";
import { sound } from "../sound/engine";
import { spawnRipple } from "./ripple";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "glass";
export type ButtonSize = "sm" | "md" | "lg" | "icon" | "icon-sm";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onAnimationStart" | "onDrag" | "onDragStart" | "onDragEnd"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  iconRight?: ReactNode;
  loading?: boolean;
  /** Klick-Sound abschalten (z. B. wenn die Aktion einen eigenen Sound spielt) */
  silent?: boolean;
}

const variantClass: Record<ButtonVariant, string> = {
  primary:
    "bg-gradient-accent text-accent-fg shadow-[0_8px_28px_-10px_var(--nv-accent)] hover:shadow-[0_10px_38px_-8px_var(--nv-accent)] [text-shadow:0_1px_1px_rgb(0_0_0/0.15)]",
  secondary: "bg-surface-2 text-fg border border-line hover:bg-surface-3 hover:border-line-strong",
  glass: "glass text-fg hover:bg-surface-2",
  ghost: "bg-transparent text-fg-soft hover:bg-surface-2 hover:text-fg",
  danger: "bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25",
};

const sizeClass: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5 rounded-sm",
  md: "h-10 px-4 text-sm gap-2 rounded-md",
  lg: "h-12 px-6 text-[15px] gap-2.5 rounded-lg",
  icon: "h-10 w-10 rounded-md",
  "icon-sm": "h-8 w-8 rounded-sm",
};

/** Knopf mit Ripple, Glühen und sanftem Eindrücken */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, iconRight, loading, silent, className, children, disabled, onClick, onPointerDown, onMouseEnter, ...rest },
  ref,
) {
  const isDisabled = disabled || loading;
  return (
    <motion.button
      ref={ref}
      type="button"
      disabled={isDisabled}
      whileHover={isDisabled ? undefined : { y: -1 }}
      whileTap={isDisabled ? undefined : { scale: 0.96, y: 0 }}
      transition={spring.snappy}
      className={cn(
        "relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden font-medium whitespace-nowrap",
        "transition-[background-color,border-color,box-shadow,color,opacity] duration-200 ease-nova",
        "disabled:cursor-not-allowed disabled:opacity-45",
        variantClass[variant],
        sizeClass[size],
        className,
      )}
      onPointerDown={(e) => {
        if (!isDisabled) spawnRipple(e);
        onPointerDown?.(e);
      }}
      onMouseEnter={(e) => {
        if (!isDisabled) sound.play("hover");
        onMouseEnter?.(e);
      }}
      onClick={(e) => {
        if (!silent) sound.play("click");
        onClick?.(e);
      }}
      {...rest}
    >
      {variant === "primary" && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 hover:opacity-100"
          style={{ background: "radial-gradient(120% 140% at 50% 0%, rgb(255 255 255 / 0.28), transparent 60%)" }}
        />
      )}
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children !== undefined && children !== null && <span className="relative truncate">{children}</span>}
      {iconRight}
    </motion.button>
  );
});
