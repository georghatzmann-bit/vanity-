/**
 * Match-Zeitleiste: Spuren untereinander mit gemeinsamer, waagerecht scrollbarer Zeitachse; Zoom „ganze
 * Runde“ / 5 min / 1 min; Umschalt + Mausrad scrollt. Ursachen-Symbole und Tooltip als HTML über dem
 * Canvas. Ohne Rohdaten (`timeline = null`): nur die Ping-Spur aus der verdichteten Kurve.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Cpu } from "lucide-react";
import { formatTime } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { CAUSE_ICONS, CAUSE_TONE, causeLine, fmtMbps, fmtMs, reasonText, visibleReasons, zoneText } from "@/lib/lag";

const ms = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : `${fmtMs(v)} ms`);
import {
  ZOOMS,
  contentWidth,
  estimateInterval,
  eventBands,
  eventCount,
  formatElapsed,
  nearestIndex,
  niceCeil,
  pingScaleMax,
  rollingJitter,
  scrollForCenter,
  spikeMarks,
  visibleRange,
  type Band,
  type SpikeMark,
} from "@/lib/timeline";
import { type NetEvent, type SessionTimeline, type SpikeDetail, type TargetKind, type TimelinePoint, type TimelineZoom } from "@/lib/types";
import { Segmented } from "@/components/ui/Segmented";
import { cn } from "@shared/lib/cn";
import { TimelineCanvas, trackLayout, usePalette, type Prepared, type TrackKey } from "./TimelineTracks";

type Translate = ReturnType<typeof useT>;

const LABEL_W = 96;

const targetKindOf = (key: string | null): TargetKind | null =>
  key === null ? null : key.startsWith("aws-") ? "region" : key.startsWith("valve-") || key.startsWith("riot-") ? "server" : "other";

function bandLabel(b: Band, t: Translate): string {
  if (b.kind === "quiet") {
    const reason = (b.event.detail as { reason?: string } | null)?.reason;
    return reason === "speedtest" ? t("timeline.band.quietSpeedtest") : reason === "wifiScan" ? t("timeline.band.quietWifiScan") : t("timeline.band.quiet");
  }
  return t(`timeline.band.${b.kind}`);
}

function prepare(timeline: SessionTimeline | null, fallback: [number, number | null][], start: number, end: number): Prepared {
  const points: TimelinePoint[] = timeline ? timeline.points : fallback.map(([t, rtt]) => [t, rtt, null, null, null]);
  const events = timeline?.events ?? [];
  const intervalMs = estimateInterval(points);
  const { limit, marks } = spikeMarks(points, events, intervalMs);
  const jitter = rollingJitter(points);
  const jMax = jitter.reduce<number>((a, v) => (v !== null && v > a ? v : a), 0);
  const traffic = points.reduce<number>((a, p) => Math.max(a, p[3] ?? 0, p[4] ?? 0), 0);
  const labels = new Map(timeline?.targets.map((x) => [x.key, x.label]) ?? []);
  return {
    start,
    end: Math.max(end, start + 1000),
    points,
    jitter,
    intervalMs,
    limit,
    marks,
    bands: eventBands(events, intervalMs),
    targetChanges: (timeline?.targetChanges ?? []).map((c) => ({ t: c.t, label: labels.get(c.key) ?? c.key })),
    pingMax: pingScaleMax(points, limit),
    jitterMax: niceCeil(jMax * 1.1, 5),
    trafficMax: niceCeil(traffic * 1.1, 1),
    pingOnly: !timeline,
  };
}

function TipRow({ label, children, color }: { label: string; children: ReactNode; color?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-muted">{label}</span>
      <span className="font-semibold text-fg tabular" style={color ? { color } : undefined}>
        {children}
      </span>
    </div>
  );
}

/** Inhalt des Tooltips eines Ausreißers mit Momentaufnahme */
function SpikeTip({ ev, t }: { ev: NetEvent; t: Translate }) {
  const d = ev.detail as Partial<SpikeDetail> | null;
  const cause = ev.cause ?? "unknown";
  const Icon = CAUSE_ICONS[cause];
  const snap = d?.snap;
  const reasons = d?.reasons ? visibleReasons({ reasons: d.reasons }) : [];
  return (
    <div className="mt-2 border-t border-line pt-2">
      <div className="flex items-center gap-1.5 font-semibold" style={{ color: CAUSE_TONE[cause] }}>
        <Icon className="h-3.5 w-3.5" /> {causeLine(cause, targetKindOf(ev.targetKey), t)}
        <span className="ml-auto rounded bg-surface-2 px-1.5 text-[10px] font-semibold tracking-wide text-muted uppercase">{t("lag.estimate")}</span>
      </div>
      {eventCount(ev) > 1 && <div className="mt-0.5 text-muted">{t("timeline.tip.count", { n: eventCount(ev) })}</div>}
      {snap ? (
        <div className="mt-1.5 space-y-0.5">
          {snap.tgt !== null && <TipRow label={t("timeline.tip.targetAtSnap")}>{ms(snap.tgt)}</TipRow>}
          {snap.gw !== null && (
            <TipRow label={t("timeline.tip.router")}>
              {ms(snap.gw)}
              {snap.gwB !== null && <span className="font-normal text-muted"> (Ø {fmtMs(snap.gwB)})</span>}
            </TipRow>
          )}
          {snap.hops.length > 0 && (
            <TipRow label={t("timeline.tip.hops")}>
              {snap.hops
                .slice(0, 3)
                .map(([, rtt, zone]) => (zone ? `${zoneText({ zone, cgnat: false, rtt, address: null }, t)} ${ms(rtt)}` : ms(rtt)))
                .join(" · ")}
            </TipRow>
          )}
          {snap.rssi !== null && <TipRow label={t("timeline.tip.wifi")}>{`${snap.rssi} dBm`}</TipRow>}
          {(snap.rx !== null || snap.tx !== null) && <TipRow label={t("timeline.tip.traffic")}>{`↓ ${fmtMbps(snap.rx)} · ↑ ${fmtMbps(snap.tx)} Mbit/s`}</TipRow>}
          {snap.cpu !== null && <TipRow label={t("timeline.tip.cpu")}>{`${Math.round(snap.cpu)} %`}</TipRow>}
        </div>
      ) : (
        <div className="mt-1 text-muted">{t("timeline.tip.noSnapshot")}</div>
      )}
      {reasons.length > 0 && (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-fg-soft">
          {reasons.slice(0, 3).map((r) => (
            <li key={r}>{reasonText(r, t)}</li>
          ))}
        </ul>
      )}
      {d?.cpuHigh && (
        <div className="mt-1.5 flex items-center gap-1.5 text-warning">
          <Cpu className="h-3.5 w-3.5" /> {t("lag.cpuHigh")}
        </div>
      )}
    </div>
  );
}

interface Hover {
  /** Zeit unter dem Mauszeiger */
  t: number;
  /** x im sichtbaren Ausschnitt */
  vx: number;
  /** Ausreißer, über dessen Symbol die Maus steht */
  spike: SpikeMark | null;
}

export function Timeline({ timeline, fallback = [], start, end, className }: { timeline: SessionTimeline | null; fallback?: [number, number | null][]; start: number; end: number; className?: string }) {
  const t = useT();
  const pal = usePalette();
  const data = useMemo(() => prepare(timeline, fallback, start, end), [timeline, fallback, start, end]);
  const { tracks, height } = useMemo(() => trackLayout(data.pingOnly), [data.pingOnly]);
  const scroller = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<TimelineZoom>("all");
  const [vw, setVw] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [hover, setHover] = useState<Hover | null>(null);
  const pendingCenter = useRef<number | null>(null);

  const duration = data.end - data.start;
  const cw = contentWidth(duration, vw, zoom);
  const [from, to] = visibleRange(data.start, data.end, scroll, vw, cw);
  const pxPerMs = cw / Math.max(1, duration);

  // Breite beobachten
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setVw(el.clientWidth));
    ro.observe(el);
    setVw(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Umschalt + Mausrad scrollt waagerecht (auch wenn das System das nicht selbst umsetzt)
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.shiftKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Beim Zoomen die Mitte (bzw. die Zeit unter der Maus) halten
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || pendingCenter.current === null) return;
    const left = scrollForCenter(data.start, data.end, pendingCenter.current, el.clientWidth, cw);
    pendingCenter.current = null;
    el.scrollLeft = left;
    setScroll(left);
  }, [cw, data.start, data.end]);

  const changeZoom = (z: TimelineZoom) => {
    pendingCenter.current = hover?.t ?? (from + to) / 2;
    setZoom(z);
  };

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (el) setScroll(el.scrollLeft);
  }, []);

  const labels = useMemo(
    () => ({
      limit: (ms: number) => t("timeline.legend.limit", { ms }),
      band: (b: Band) => bandLabel(b, t),
      change: (label: string) => t("timeline.legend.targetChange", { label }),
    }),
    [t],
  );

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = scroller.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vx = e.clientX - rect.left;
    const tt = data.start + (el.scrollLeft + vx) / Math.max(1e-9, pxPerMs);
    // Über einem Ursachen-Symbol: Werte genau zum Ausreißer zeigen
    setHover((h) => {
      const spike = h?.spike && Math.abs(h.spike.t - tt) * pxPerMs < 14 ? h.spike : null;
      return { t: spike ? spike.t : tt, vx, spike };
    });
  };

  const spikeTrack = tracks.find((x) => x.key === "spikes");
  const visibleMarks = useMemo(() => data.marks.filter((m) => m.event && m.t >= from - 5000 && m.t <= to + 5000), [data.marks, from, to]);

  // Tooltip-Inhalt
  const tip = useMemo(() => {
    if (!hover) return null;
    const i = nearestIndex(data.points, hover.t);
    const p = i >= 0 ? data.points[i] : null;
    const within = p && Math.abs(p[0] - hover.t) <= Math.max(2000, data.intervalMs * 2, 6 / Math.max(1e-9, pxPerMs));
    const bands = data.bands.filter((b) => hover.t >= b.from && hover.t <= b.to);
    const spike = hover.spike ?? data.marks.find((m) => m.event && Math.abs(m.t - hover.t) * pxPerMs <= 6) ?? null;
    return { p: within ? p : null, jitter: within ? data.jitter[i] : null, bands, spike };
  }, [hover, data, pxPerMs]);

  const tipLeft = hover ? Math.min(Math.max(8, hover.vx + 14), Math.max(8, vw - 268)) : 0;
  const flip = hover ? hover.vx + 14 + 260 > vw : false;

  const trackNames: Record<TrackKey, string> = {
    ping: t("timeline.track.ping"),
    jitter: t("timeline.track.jitter"),
    loss: t("timeline.track.loss"),
    spikes: t("timeline.track.spikes"),
    load: t("timeline.track.load"),
  };

  return (
    <div className={cn("glass rounded-xl p-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
          {!data.pingOnly && (
            <>
              <span className="flex items-center gap-1.5">
                <i className="h-2 w-3 rounded-sm bg-[var(--nv-accent-2)] opacity-60" /> {t("timeline.legend.cpu")}
              </span>
              <span className="flex items-center gap-1.5">
                <i className="h-0.5 w-3 bg-[var(--nv-success)]" /> {t("timeline.legend.rx")}
              </span>
              <span className="flex items-center gap-1.5">
                <i className="h-0.5 w-3 bg-[var(--nv-warning)]" /> {t("timeline.legend.tx")}
              </span>
            </>
          )}
          {data.limit !== null && (
            <span className="flex items-center gap-1.5">
              <i className="h-0 w-3 border-t border-dashed border-[var(--nv-warning)]" /> {t("timeline.legend.limit", { ms: Math.round(data.limit) })}
            </span>
          )}
          <span className="hidden text-faint xl:inline">{t("timeline.scrollHint")}</span>
        </div>
        <Segmented size="sm" value={zoom} onChange={changeZoom} options={ZOOMS.map((z) => ({ value: z, label: t(`timeline.zoom.${z}`) }))} />
      </div>

      <div className="mt-3 flex">
        {/* Spur-Namen */}
        <div className="relative shrink-0" style={{ width: LABEL_W, height }}>
          {tracks.map((tr) => (
            <div key={tr.key} className="absolute right-3 left-0 flex items-center text-[11px] font-semibold tracking-[0.08em] text-muted uppercase" style={{ top: tr.top, height: tr.height }}>
              {trackNames[tr.key]}
            </div>
          ))}
        </div>

        {/* Spuren (scrollbar) */}
        <div className="relative min-w-0 flex-1">
          <div
            ref={scroller}
            tabIndex={0}
            role="figure"
            aria-label={t("timeline.title")}
            className="timeline-scroll overflow-x-auto overflow-y-hidden rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[var(--nv-accent)]"
            onScroll={onScroll}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          >
            <div className="relative" style={{ width: Math.max(cw, 1), height }}>
              {pal && vw > 0 && <TimelineCanvas className="sticky left-0" data={data} pal={pal} width={vw} height={height} from={from} to={to} hoverT={hover?.t ?? null} labels={labels} />}
              {/* Ursachen-Symbole an Ausreißern mit Momentaufnahme */}
              {spikeTrack &&
                visibleMarks.map((m) => {
                  const cause = m.cause ?? "unknown";
                  const Icon = CAUSE_ICONS[cause];
                  return (
                    <button
                      key={m.t}
                      type="button"
                      className="absolute grid h-6 w-6 -translate-x-1/2 place-items-center rounded-full border bg-[var(--nv-surface-solid)] shadow-sm transition-transform hover:scale-110"
                      style={{ left: (m.t - data.start) * pxPerMs, top: spikeTrack.top + spikeTrack.height / 2 - 12, color: CAUSE_TONE[cause], borderColor: CAUSE_TONE[cause] }}
                      aria-label={causeLine(cause, targetKindOf(m.event?.targetKey ?? null), t)}
                      onMouseEnter={() => setHover({ t: m.t, vx: (m.t - data.start) * pxPerMs - (scroller.current?.scrollLeft ?? scroll), spike: m })}
                      onFocus={() => setHover({ t: m.t, vx: (m.t - data.start) * pxPerMs - scroll, spike: m })}
                      onBlur={() => setHover(null)}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </button>
                  );
                })}
            </div>
          </div>

          <AnimatePresence>
            {hover && tip && (tip.p || tip.bands.length > 0 || tip.spike) && (
              <motion.div
                key="tip"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.12 }}
                className="glass-strong pointer-events-none absolute z-20 w-[260px] rounded-lg px-3 py-2.5 text-[12px] shadow-lg"
                style={{ left: flip ? Math.max(8, hover.vx - 274) : tipLeft, top: 8 }}
              >
                <div className="mb-1.5 text-[11px] font-semibold text-fg-soft">
                  {t("timeline.tip.time", { elapsed: formatElapsed((tip.p?.[0] ?? hover.t) - data.start), clock: formatTime(tip.p?.[0] ?? hover.t, true) })}
                </div>
                {tip.p && (
                  <div className="space-y-0.5">
                    <TipRow label={t("timeline.tip.ping")} color={tip.p[1] === null ? "var(--nv-danger)" : undefined}>
                      {tip.p[1] === null ? t("timeline.tip.lost") : ms(tip.p[1])}
                    </TipRow>
                    {!data.pingOnly && tip.jitter !== null && tip.jitter !== undefined && <TipRow label={t("timeline.tip.jitter")}>{ms(tip.jitter)}</TipRow>}
                    {tip.p[2] !== null && <TipRow label={t("timeline.tip.cpu")}>{`${Math.round(tip.p[2])} %`}</TipRow>}
                    {(tip.p[3] !== null || tip.p[4] !== null) && <TipRow label={t("timeline.tip.traffic")}>{`↓ ${fmtMbps(tip.p[3])} · ↑ ${fmtMbps(tip.p[4])} Mbit/s`}</TipRow>}
                  </div>
                )}
                {tip.bands.map((b) => (
                  <div key={`${b.kind}-${b.from}`} className="mt-1.5 flex items-start gap-1.5 text-[11px]" style={{ color: b.kind === "quiet" ? "var(--nv-muted)" : b.kind === "slow" ? "var(--nv-warning)" : "var(--nv-danger)" }}>
                    <span className="mt-1 h-2 w-2 shrink-0 rounded-sm bg-current opacity-70" />
                    <span>
                      <span className="font-semibold">{bandLabel(b, t)}</span> · {formatElapsed(b.from - data.start)}–{formatElapsed(b.to - data.start)}
                      {b.kind === "outage" && b.event.scope && <span className="block text-muted">{t("timeline.tip.scope", { scope: t(`timeline.scope.${b.event.scope}`) })}</span>}
                      {b.kind === "quiet" && <span className="block text-muted">{t("timeline.band.quietNote")}</span>}
                    </span>
                  </div>
                ))}
                {tip.spike?.event && <SpikeTip ev={tip.spike.event} t={t} />}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
