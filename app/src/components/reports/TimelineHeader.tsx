/**
 * Kopf der Match-Zeitleiste: Spiel, Datum, Dauer, Note, Ø/Min/Max, Schwankung, Verlust, Ausreißer,
 * Messziel(e) und die Ursachen der Momentaufnahmen („{n} von {m} Ausreißern untersucht“).
 */
import { ImageDown, Info, Siren } from "lucide-react";
import { formatDateTime, formatDuration, formatNumber } from "@/lib/format";
import { pingColor } from "@/lib/grade";
import { useT } from "@/lib/i18n";
import { CAUSE_ICONS, CAUSE_TONE } from "@/lib/lag";
import { causeSummary } from "@/lib/lagtext";
import type { HeaderModel } from "@/lib/timeline";
import { LAG_CAUSES, type Game } from "@/lib/types";
import { useUI } from "@/store/ui";
import { GameCover } from "@/components/GameCover";
import { GradeRing } from "@/components/net/GradeRing";
import { Button } from "@shared/ui/Button";
import { cn } from "@shared/lib/cn";

const ms = (v: number | null) => (v === null ? "–" : `${formatNumber(v, v < 10 ? 1 : 0)}`);

function Stat({ label, value, unit, color, className }: { label: string; value: string; unit?: string; color?: string; className?: string }) {
  return (
    <div className={cn("min-w-0 rounded-lg bg-surface px-3 py-2", className)}>
      <div className="truncate text-[10px] font-semibold tracking-[0.12em] text-faint uppercase">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1 truncate font-display text-lg font-bold text-fg tabular" style={color ? { color } : undefined}>
        {value}
        {unit && value !== "–" && <span className="text-[11px] font-medium text-muted">{unit}</span>}
      </div>
    </div>
  );
}

export function TimelineHeader({ header: h, game, onSaveImage, sessionOnly }: { header: HeaderModel; game?: Game; onSaveImage: () => void; sessionOnly: boolean }) {
  const t = useT();
  const counts = LAG_CAUSES.map((c) => ({ c, n: Math.round(h.causes[c] ?? 0) })).filter((x) => x.n > 0);
  return (
    <div className="glass relative overflow-hidden rounded-xl p-5">
      {game?.palette && (
        <div className="pointer-events-none absolute inset-0 opacity-[0.16]" style={{ background: `radial-gradient(120% 140% at 0% 0%, ${game.palette.primary}, transparent 55%)` }} />
      )}
      {/* Note oben rechts (unter 1100 px kleiner); der Inhalt lässt rechts Platz dafür */}
      <div className="absolute top-5 right-5 z-[1]">
        <span className="hidden min-[1100px]:block">
          <GradeRing grade={h.grade} size={84} label={t("timeline.card.grade")} />
        </span>
        <span className="block min-[1100px]:hidden">
          <GradeRing grade={h.grade} size={72} label={t("timeline.card.grade")} />
        </span>
      </div>
      <div className="relative flex items-start gap-5 pr-[88px] min-[1100px]:pr-[100px]">
        {game && (
          <button type="button" onClick={() => useUI.getState().navigate({ page: "game", id: game.id })} className="hidden h-[104px] w-[74px] shrink-0 overflow-hidden rounded-lg shadow-md sm:block" title={game.name}>
            <GameCover game={game} />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold tracking-[0.14em] text-accent uppercase">{t("timeline.title")}</div>
          <h1 className="mt-1 truncate font-display text-3xl font-bold text-fg">{h.gameName}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
            <span>{formatDateTime(h.start)}</span>
            <span>·</span>
            <span>
              {t("timeline.header.duration")} {formatDuration(h.durationS)}
            </span>
            {h.targets.length > 0 && (
              <>
                <span>·</span>
                <span className="truncate">
                  {h.targets.length > 1 ? t("timeline.header.targets") : t("timeline.header.target")}: <span className="text-fg-soft">{h.targets.join(" → ")}</span>
                </span>
              </>
            )}
          </div>
          {sessionOnly && (
            <div className="mt-2 flex items-center gap-1.5 text-[12px] text-muted">
              <Info className="h-3.5 w-3.5 shrink-0" /> {t("timeline.sessionOnly")}
            </div>
          )}
          <Button variant="secondary" size="sm" className="mt-3" icon={<ImageDown className="h-4 w-4" />} onClick={onSaveImage}>
            {t("timeline.saveImage")}
          </Button>
        </div>
      </div>

      <div className="relative mt-4 grid grid-cols-3 gap-2 md:grid-cols-5">
        <Stat label={t("timeline.header.avg")} value={ms(h.avg)} unit="ms" color={h.avg === null ? undefined : pingColor(h.avg)} />
        <Stat label={t("timeline.header.minMax")} value={h.min === null ? "–" : `${ms(h.min)} / ${ms(h.max)}`} unit="ms" />
        <Stat label={t("timeline.header.jitter")} value={ms(h.jitter)} unit="ms" color={h.jitter !== null && h.jitter >= 12 ? "var(--nv-warning)" : undefined} />
        <Stat label={t("timeline.header.loss")} value={formatNumber(h.loss * 100, 1)} unit="%" color={h.loss > 0.01 ? "var(--nv-danger)" : undefined} />
        <Stat label={t("timeline.header.spikes")} value={String(h.spikes)} color={h.spikes > 10 ? "var(--nv-warning)" : undefined} className="col-span-2 md:col-span-1" />
      </div>

      <div className="relative mt-3 rounded-lg border border-line bg-surface px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.1em] text-muted uppercase">
            <Siren className="h-3.5 w-3.5 text-accent" /> {t("timeline.header.causesTitle")}
          </div>
          <div className="text-[11px] text-muted tabular">{t("timeline.header.examined", { n: h.examined, m: h.spikes })}</div>
        </div>
        <div className="mt-1.5 text-[13px] text-fg-soft">{causeSummary(h.causes, t)}</div>
        {counts.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {counts.map(({ c, n }) => {
              const Icon = CAUSE_ICONS[c];
              return (
                <span key={c} className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold" style={{ color: CAUSE_TONE[c], borderColor: `color-mix(in oklab, ${CAUSE_TONE[c]} 45%, transparent)` }}>
                  <Icon className="h-3 w-3" /> {n}× {t(`lag.cause.${c}`)}
                </span>
              );
            })}
          </div>
        )}
        <div className="mt-1.5 text-[11px] text-faint">{t("timeline.header.estimate")}</div>
      </div>
    </div>
  );
}
