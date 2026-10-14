/**
 * Knopf des Radioteleskops (B.7): Primär knochenweiß, nie gelb. Klänge hover/click außer `silent`.
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@shared/lib/cn";
import { sound } from "@shared/sound/engine";

export type ObsButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-solid";

export interface ObsButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant: ObsButtonVariant;
  size?: "sm" | "md" | "lg";
  icon?: ReactNode;
  iconRight?: ReactNode;
  /** ohne Hover-/Klickklang */
  silent?: boolean;
}

export const ObsButton = forwardRef<HTMLButtonElement, ObsButtonProps>(function ObsButton(
  { variant, size = "md", icon, iconRight, silent, className, children, onClick, onMouseEnter, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn("obs-btn", `obs-btn-${variant}`, size !== "md" && `obs-btn-${size}`, className)}
      onMouseEnter={(e) => {
        if (!silent && !e.currentTarget.disabled) sound.play("hover");
        onMouseEnter?.(e);
      }}
      onClick={(e) => {
        if (!silent) sound.play("click");
        onClick?.(e);
      }}
      {...rest}
    >
      {icon}
      <span className="obs-btn-text">{children}</span>
      {iconRight}
    </button>
  );
});
