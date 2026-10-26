import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Loading placeholder with a moving shine. Size it with classes: <Skeleton className="h-4 w-32" />. */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div aria-hidden className={cn("skeleton rounded-md", className)} {...props} />;
}

/**
 * Text in the brand gradient. "soft" (default) = white → violet → cyan, for headlines.
 * "brand" = cyan → violet, for one big number or word.
 */
export function GradientText({
  children,
  variant = "soft",
  className,
}: {
  children: ReactNode;
  variant?: "soft" | "brand";
  className?: string;
}) {
  return <span className={cn(variant === "brand" ? "text-gradient-brand" : "text-gradient", className)}>{children}</span>;
}

/**
 * The sheen sweep as a layer: put it inside an element with `group relative overflow-hidden`.
 * It sweeps on hover of the group, and once on mount with `once`.
 */
export function Sheen({ once = false, className }: { once?: boolean; className?: string }) {
  return (
    <span aria-hidden className={cn("pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]", className)}>
      <span className={cn("sheen", once && "sheen-once")} />
    </span>
  );
}

/**
 * Decorative light for a hero card: violet and cyan glows, a slowly turning sheen and fine diagonal lines.
 * Put it as the first child of a `relative overflow-hidden` card.
 */
export function HeroBackdrop({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]", className)}>
      <div className="absolute -top-40 -right-24 size-[28rem] rounded-full bg-[radial-gradient(closest-side,rgb(139_92_246/0.42),transparent)]" />
      <div className="absolute -bottom-48 left-1/4 size-[26rem] rounded-full bg-[radial-gradient(closest-side,rgb(34_211_238/0.3),transparent)]" />
      <div className="absolute -right-10 -bottom-16 size-48 rounded-full bg-[radial-gradient(closest-side,rgb(34_211_238/0.12),transparent)]" />
      <div className="nb-loop absolute top-1/2 left-1/2 size-[160%] -translate-x-1/2 -translate-y-1/2 [animation:nb-orbit_40s_linear_infinite]">
        <div className="size-full bg-[conic-gradient(from_210deg_at_50%_50%,transparent_0deg,rgb(196_181_253/0.08)_40deg,transparent_90deg,transparent_200deg,rgb(103_232_249/0.06)_240deg,transparent_290deg)]" />
      </div>
      <div
        className="absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage: "repeating-linear-gradient(115deg, #fff 0 1px, transparent 1px 22px)",
          maskImage: "linear-gradient(90deg, transparent 40%, black 100%)",
        }}
      />
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent" />
    </div>
  );
}

/** Small dot that says "new" (cyan, softly glowing). */
export function NewDot({ className }: { className?: string }) {
  return (
    <span className={cn("relative inline-flex size-2", className)}>
      <span className="nb-loop absolute inset-0 rounded-full bg-brand-cyan opacity-60 animate-ping" />
      <span className="relative inline-flex size-2 rounded-full bg-brand-cyan shadow-[0_0_8px_rgb(34_211_238/0.7)]" />
    </span>
  );
}
