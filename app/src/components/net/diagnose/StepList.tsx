/** „Warum laggt es?“: Prüfschritte mit Zustand, Fortschritt und kurzen Messwerten. */
import { useState } from "react";
import { Ban, Check, ChevronDown, Circle, Loader2, MinusCircle, ToggleLeft, X } from "lucide-react";
import { lostOf, primaryAdapter, routeJump, trafficMbps } from "@/lib/diagnose";
import { zoneText } from "@/lib/lag";
import { backendText } from "@/lib/netauto";
import { useT } from "@/lib/i18n";
import { DIAGNOSE_STEPS, type DiagnoseInput, type DiagnoseStepId, type SpeedProgress, type TraceHop } from "@/lib/types";
import type { LiveStep } from "@/store/diagnose";
import { fmt } from "./FindingList";
import { ProgressBar } from "@shared/ui/ProgressBar";
import { cn } from "@shared/lib/cn";

type Translate = ReturnType<typeof useT>;

/** Millisekunden im Format der Sprache (unter 10 ms eine Nachkommastelle) */
const fmtMs = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "–" : fmt(v, v < 10 ? 1 : 0));

/** Gewicht je Schritt für den Gesamtfortschritt (ungefähre Dauer) */
const WEIGHT: Record<DiagnoseStepId, number> = { connection: 1, router: 1, server: 2, route: 3, local: 2, speed: 8 };

/** Fortschritt innerhalb des Speedtests (Ping 10 %, Download 50 %, Upload 40 %) */
function speedFraction(p: SpeedProgress | null): number {
  if (!p) return 0;
  if (p.phase === "latency") return 0.1 * p.progress;
  if (p.phase === "download") return 0.1 + 0.5 * p.progress;
  if (p.phase === "upload") return 0.6 + 0.4 * p.progress;
  return 1;
}

/** Gesamtfortschritt 0–1 */
export function overallProgress(steps: Record<DiagnoseStepId, LiveStep>, speed: SpeedProgress | null, hops: number): number {
  let total = 0;
  let done = 0;
  for (const id of DIAGNOSE_STEPS) {
    const st = steps[id].status;
    if (st === "off") continue;
    total += WEIGHT[id];
    if (st === "running") done += WEIGHT[id] * (id === "speed" ? speedFraction(speed) : id === "route" ? Math.min(0.9, hops / 10) : 0.4);
    else if (st !== "pending") done += WEIGHT[id];
  }
  return total ? done / total : 0;
}

function StatusIcon({ status }: { status: LiveStep["status"] }) {
  const cls = "h-4 w-4";
  switch (status) {
    case "running":
      return <Loader2 className={cn(cls, "animate-spin text-accent")} />;
    case "done":
      return <Check className={cn(cls, "text-success")} />;
    case "failed":
      return <X className={cn(cls, "text-danger")} />;
    case "skipped":
      return <MinusCircle className={cn(cls, "text-muted")} />;
    case "off":
      return <ToggleLeft className={cn(cls, "text-muted")} />;
    case "cancelled":
      return <Ban className={cn(cls, "text-muted")} />;
    default:
      return <Circle className={cn(cls, "text-faint")} />;
  }
}

/** Kurze Messwerte eines fertigen bzw. laufenden Schritts (Liste = eigene Zeilen, die zweite leiser) */
function stepDetail(
  id: DiagnoseStepId,
  input: DiagnoseInput | null,
  live: { speed: SpeedProgress | null; hops: TraceHop[]; serverLive: boolean; running: boolean },
  t: Translate,
): string | string[] | null {
  if (live.running && id === "route") return live.hops.length ? t("diagnose.detail.routeLive", { n: live.hops.length }) : null;
  if (live.running && id === "speed") {
    const p = live.speed;
    return p ? t("diagnose.detail.speedLive", { phase: t(`diagnose.detail.phase.${p.phase}`), mbps: p.mbps !== null ? `${fmt(p.mbps, 0)} Mbit/s` : "" }).trim() : null;
  }
  if (!input || live.running) return null;
  switch (id) {
    case "connection": {
      const primary = primaryAdapter(input.adapters);
      if (!primary) return null;
      const parts: string[] = [];
      if (primary.kind === "wifi") {
        const w = input.wifiState?.state === "connected" ? input.wifiState.wifi : null;
        if (input.wifiState?.state === "locked") parts.push(t("diagnose.detail.locked"));
        else if (w && w.rssi !== null) parts.push(t("diagnose.detail.wifi", { band: w.band ? fmt(Number(w.band), 1) : "?", rssi: Math.round(w.rssi) }));
        else if (w) parts.push(t("diagnose.detail.wifiNoRssi", { band: w.band ? fmt(Number(w.band), 1) : "?", signal: Math.round(w.signal) }));
      } else parts.push(t(primary.kind === "ethernet" ? "diagnose.detail.cable" : "diagnose.detail.other"));
      if (input.metered) parts.push(t("diagnose.detail.metered"));
      return parts.join(" · ") || null;
    }
    case "router": {
      const r = input.router;
      const main = r ? (r.avg !== null && r.loss < 1 ? t("diagnose.detail.router", { ms: fmtMs(r.avg), lost: lostOf(r), n: r.samples }) : t("diagnose.detail.routerNoAnswer")) : null;
      const hops = input.snapshot?.snapshot.hops ?? [];
      const list = hops.length ? t("diagnose.detail.hops", { list: hops.map((h) => t("diagnose.detail.hop", { zone: zoneText(h, t), ms: h.rtt !== null ? fmtMs(h.rtt) : "–" })).join(" · ") }) : null;
      if (main && list) return [main, list];
      return main ?? list;
    }
    case "server": {
      const s = input.server;
      if (!s) return null;
      const text = t("diagnose.detail.server", { target: input.target?.label ?? "", ms: fmtMs(s.avg), jitter: fmtMs(s.jitter), lost: lostOf(s), n: s.samples });
      return live.serverLive ? `${text} (${t("diagnose.detail.serverLive")})` : text;
    }
    case "route": {
      if (!input.trace) return null;
      // Ein Anstieg auf der Route steht immer hier – als Befund nur, wenn das Ziel auffällig ist
      const rj = routeJump(input.trace.hops, primaryAdapter(input.adapters)?.gateway ?? null);
      return rj.hop !== null && rj.jumpMs !== null
        ? t("diagnose.detail.routeJump", { n: input.trace.hops.length, hop: rj.hop, ms: fmtMs(rj.jumpMs) })
        : t("diagnose.detail.route", { n: input.trace.hops.length });
    }
    case "local": {
      if (!input.system) return null;
      const tr = trafficMbps(input.counters);
      return tr ? t("diagnose.detail.local", { cpu: Math.round(input.system.cpu), mbps: fmt(tr.total, 1) }) : t("diagnose.detail.localNoTraffic", { cpu: Math.round(input.system.cpu) });
    }
    case "speed": {
      const s = input.speed;
      return s ? t("diagnose.detail.speed", { down: fmt(s.downloadMbps, 0), up: fmt(s.uploadMbps, 0), bloat: fmt(s.bufferbloatMs, 0) }) : null;
    }
  }
}

export function StepList({
  steps,
  input,
  speed,
  hops,
  serverLive,
  showProgress,
  collapsible = false,
}: {
  steps: Record<DiagnoseStepId, LiveStep>;
  input: DiagnoseInput | null;
  speed: SpeedProgress | null;
  hops: TraceHop[];
  serverLive: boolean;
  showProgress: boolean;
  /** nach Abschluss eingeklappt („Prüfschritte · 6 von 6 fertig“), aufklappbar */
  collapsible?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const pct = overallProgress(steps, speed, hops.length);
  const counted = DIAGNOSE_STEPS.filter((id) => steps[id].status !== "off");
  const done = counted.filter((id) => steps[id].status === "done").length;
  const expanded = !collapsible || open;
  return (
    <div className={cn("glass rounded-xl", collapsible ? "px-5 py-3.5" : "p-5")} data-testid="diagnose-steps" data-expanded={expanded}>
      {collapsible ? (
        <button type="button" className="flex w-full items-center justify-between gap-3 text-left" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{t("diagnose.stepsDone", { done, n: counted.length })}</span>
          <ChevronDown className={cn("h-4 w-4 text-muted transition-transform", open && "rotate-180")} />
        </button>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <div className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{t("diagnose.stepsTitle")}</div>
          {showProgress && <span className="text-[11px] text-faint tabular">{t("diagnose.progress", { pct: Math.round(pct * 100) })}</span>}
        </div>
      )}
      {showProgress && <ProgressBar value={pct} className="mt-3" />}
      {expanded && (
        <ol className="mt-4 flex flex-col gap-1">
          {DIAGNOSE_STEPS.map((id, i) => {
            const s = steps[id];
            const running = s.status === "running";
            const detail = stepDetail(id, input, { speed, hops, serverLive, running }, t);
            const error = (s.status === "failed" || s.status === "skipped") && s.error ? backendText(s.error, t) : null;
            return (
              <li key={id} className={cn("flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors", running && "bg-accent/10")} data-step={id} data-status={s.status}>
                <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-surface-2">
                  <StatusIcon status={s.status} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className={cn("text-[13px] font-semibold", s.status === "pending" ? "text-muted" : "text-fg")}>
                      <span className="mr-1.5 text-faint tabular">{i + 1}.</span>
                      {t(`diagnose.step.${id}.name`)}
                    </span>
                    <span className={cn("text-[11px]", s.status === "failed" ? "text-danger" : running ? "text-accent" : "text-faint")}>{t(`diagnose.status.${s.status}`)}</span>
                  </div>
                  <div className="mt-0.5 text-[12px] text-muted">{t(`diagnose.step.${id}.desc`)}</div>
                  {running && id === "speed" && speed && <ProgressBar value={speedFraction(speed)} height={4} className="mt-2" />}
                  {detail &&
                    (Array.isArray(detail) ? detail : [detail]).map((line, n) => (
                      <div key={n} className={cn("text-[12px] tabular", n === 0 ? "mt-1 text-fg-soft" : "mt-0.5 block text-muted")}>
                        {line}
                      </div>
                    ))}
                  {error && (
                    <div className={cn("mt-1 flex items-start gap-1.5 text-[12px]", s.status === "failed" ? "text-danger" : "text-muted")}>
                      <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
