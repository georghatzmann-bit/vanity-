/**
 * Hinweis (B.7): links 2 px Balken in Ton-Farbe, Fläche Ton-Farbe 6 %, Symbol 16 px, Wort
 * HINWEIS/FEHLER (Mono 10), Titel 13/600, Text 13/20 `fg-2`. Kein Ring, kein Radius.
 */
import type { ReactNode } from "react";
import { AlertTriangle, Info, OctagonX } from "lucide-react";
import { cn } from "@shared/lib/cn";
import { useT } from "../i18n";

export interface NoticeProps {
  tone: "warn" | "error" | "neutral";
  title?: ReactNode;
  role?: "alert" | "status";
  children?: ReactNode;
  actions?: ReactNode;
  /** Wort und Text in einer Zeile (wenig Platz, ohne Titel) */
  compact?: boolean;
  className?: string;
  testId?: string;
}

const TONE = {
  warn: { color: "var(--obs-warn)", bg: "rgb(255 143 63 / 0.06)", Icon: AlertTriangle, word: "obs.hint" },
  error: { color: "var(--obs-error)", bg: "rgb(255 90 100 / 0.06)", Icon: OctagonX, word: "obs.error" },
  neutral: { color: "var(--obs-fg-2)", bg: "rgb(230 232 235 / 0.04)", Icon: Info, word: "obs.hint" },
} as const;

export function Notice({ tone, title, role, children, actions, compact, className, testId }: NoticeProps) {
  const t = useT();
  const s = TONE[tone];
  const word = (
    <span className="obs-label" style={{ color: s.color }}>
      {t(s.word)}
    </span>
  );
  return (
    <div role={role} data-testid={testId} className={cn("flex w-[472px] gap-3 py-3 pr-4 pl-[14px]", className)} style={{ background: s.bg, borderLeft: `2px solid ${s.color}` }}>
      <s.Icon aria-hidden className="mt-px h-4 w-4 shrink-0" strokeWidth={1.5} style={{ color: s.color }} />
      <div className="min-w-0 flex-1">
        {compact ? (
          <p className="m-0 text-[13px] leading-5 text-obs-fg-2">
            {word}
            <span className="ml-2">{children}</span>
          </p>
        ) : (
          <>
            <div className="leading-4">{word}</div>
            {title && <div className="mt-1 text-[13px] leading-5 font-semibold text-obs-fg">{title}</div>}
            {children && <div className="mt-0.5 text-[13px] leading-5 text-obs-fg-2">{children}</div>}
          </>
        )}
        {actions && <div className="mt-3 flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
