/**
 * Netzwerk › Verbindung: Karte „Lag-Detektiv“ mit den letzten 20 Ausreißern (`net_lag_recent` +
 * `net://lag`), aufklappbar: Ziel bei der Momentaufnahme, Stationen mit Zone und Grundwert, Router,
 * WLAN, Datenverkehr, CPU und die Begründungen als Sätze. Alles als Einschätzung gekennzeichnet.
 */
import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUpRight, ChevronDown, Cpu, Info, Siren } from "lucide-react";
import { formatTime } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { CAUSE_ICONS, CAUSE_TONE, capitalizeFirst, causeLine, causeNote, countsFromEvents, fmtMbps, fmtMs, reasonText, visibleReasons, zoneText, zoneTitle } from "@/lib/lag";
import { causeSummary } from "@/lib/lagtext";
import type { LagEvent, LagSnapshot } from "@/lib/types";
import { useLag } from "@/store/lag";
import { useSettings } from "@/store/settings";
import { useUI } from "@/store/ui";
import { cn } from "@shared/lib/cn";

type Translate = ReturnType<typeof useT>;

const keyOf = (ev: LagEvent) => `${ev.at}|${ev.targetId}`;

function Detail({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 rounded-lg bg-surface px-3 py-2", className)}>
      <div className="truncate text-[10px] font-semibold tracking-[0.1em] text-faint uppercase">{label}</div>
      <div className="mt-0.5 text-[13px] text-fg tabular">{children}</div>
    </div>
  );
}

function Sub({ children }: { children: ReactNode }) {
  return <div className="text-[11px] text-muted">{children}</div>;
}

function targetText(s: LagSnapshot, t: Translate): string {
  if (s.targetLost === null) return t("lag.card.targetNotMeasured");
  if (s.targetMs === null) return t("lag.card.targetLostAll");
  return t("lag.card.targetValue", { ms: fmtMs(s.targetMs), lost: s.targetLost });
}

/** Bezug „Leitung voll“: nur die bekannten Richtungen */
function referenceText(s: LagSnapshot): string {
  const parts = [s.refDownMbps !== null ? `↓ ${fmtMbps(s.refDownMbps)}` : null, s.refUpMbps !== null ? `↑ ${fmtMbps(s.refUpMbps)}` : null].filter(Boolean);
  return `${parts.join(" · ")} Mbit/s`;
}

function connectionText(s: LagSnapshot, t: Translate): string {
  const kind = s.connection ? t(`lag.connection.${s.connection}`) : t("lag.connection.none");
  return s.viaVpn ? `${kind} · ${t("lag.connection.vpn")}` : kind;
}

function EventDetails({ ev }: { ev: LagEvent }) {
  const t = useT();
  const s = ev.snapshot;
  const reasons = visibleReasons(ev);
  const note = causeNote(ev.cause, t);
  const baseText = (v: number | null) => (v === null ? t("lag.card.noBase") : t("lag.card.base", { ms: fmtMs(v) }));
  const off = s.tookMs === 0 && ev.reasons.includes("snapshotsOff");
  // Weiter je Ursache: WLAN → WLAN-Tab, Router/Anbieter/unklar → „Warum laggt es?“
  const link =
    ev.cause === "wifi"
      ? { section: "wifi", label: "lag.card.toWifi" }
      : ev.cause === "router" || ev.cause === "isp" || ev.cause === "unknown"
        ? { section: "diagnose", label: "lag.card.toDiagnose" }
        : null;
  return (
    <div className="space-y-3 px-4 pt-1 pb-4">
      {!off && (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
          <Detail label={t("lag.card.target")}>
            {targetText(s, t)}
            <Sub>{t("lag.card.limit", { limit: fmtMs(ev.limit) })}</Sub>
          </Detail>
          <Detail label={t("lag.card.router")}>
            {s.gatewayMs === null ? t("lag.card.hopNoAnswer") : `${fmtMs(s.gatewayMs)} ms`}
            <Sub>{baseText(s.gatewayBaseMs)}</Sub>
          </Detail>
          <Detail label={t("lag.card.connection")}>
            {connectionText(s, t)}
            {s.connection === "wifi" && (
              <Sub>
                {s.wifi
                  ? [t("lag.card.wifiValue", { signal: s.wifi.signal, rssi: s.wifi.rssi ?? "–" }), s.wifi.band ? t("lag.card.wifiBand", { band: s.wifi.band }) : null].filter(Boolean).join(" · ")
                  : s.wifiState === "locked"
                    ? t("lag.card.wifiLocked")
                    : t("lag.card.wifiNone")}
              </Sub>
            )}
          </Detail>
          <Detail label={t("lag.card.traffic")}>
            {s.rxMbps === null && s.txMbps === null ? t("lag.card.unknownValue") : t("lag.card.trafficValue", { rx: fmtMbps(s.rxMbps), tx: fmtMbps(s.txMbps) })}
            <Sub>
              {[
                s.trafficBaseMbps !== null ? t("lag.card.trafficBase", { v: fmtMbps(s.trafficBaseMbps) }) : null,
                s.refDownMbps !== null || s.refUpMbps !== null ? t("lag.card.reference", { value: referenceText(s) }) : null,
              ]
                .filter(Boolean)
                .join(" · ") || " "}
            </Sub>
          </Detail>
          <Detail label={t("lag.card.cpu")}>{s.cpu === null ? t("lag.card.unknownValue") : `${Math.round(s.cpu)} %`}</Detail>
        </div>
      )}
      {!off && (
        <div>
          <div className="px-1 text-[10px] font-semibold tracking-[0.1em] text-faint uppercase">{t("lag.card.hops")}</div>
          {s.hops.length === 0 ? (
            <div className="mt-1.5 px-1 text-[12px] text-muted">{t("lag.card.hopsNone")}</div>
          ) : (
            <div className="mt-1.5 grid gap-1.5 lg:grid-cols-3">
              {s.hops.map((h) => (
                <div key={h.ttl} className="flex min-w-0 items-center gap-2.5 rounded-lg bg-surface px-3 py-2" title={zoneTitle(h, t)}>
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-surface-3 text-[11px] font-bold text-muted tabular">{h.ttl}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-medium text-fg">{zoneText(h, t)}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-[13px] font-semibold text-fg tabular">{h.rtt === null ? "–" : `${fmtMs(h.rtt)} ms`}</div>
                    <div className="text-[10px] text-faint tabular">{h.baseMs === null ? t("lag.card.noBase") : `Ø ${fmtMs(h.baseMs)} ms`}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div>
        <div className="px-1 text-[10px] font-semibold tracking-[0.1em] text-faint uppercase">{t("lag.card.reasons")}</div>
        <ul className="mt-1.5 space-y-1.5 text-[13px] text-fg-soft">
          {reasons.map((r) => (
            <li key={r} className="flex gap-2">
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: CAUSE_TONE[ev.cause] }} />
              {reasonText(r, t)}
            </li>
          ))}
          {reasons.length === 0 && <li className="text-muted">{t("lag.unclearCause")}</li>}
          {note && (
            <li className="flex gap-2 text-muted">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {note}
            </li>
          )}
          {ev.cpuHigh && (
            <li className="flex gap-2 text-warning">
              <Cpu className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t("lag.cpuHigh")}
            </li>
          )}
        </ul>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-1">
        {link ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline"
            onClick={() => useUI.getState().navigate({ page: "network", section: link.section })}
          >
            {t(link.label)} <ArrowUpRight className="h-3.5 w-3.5" />
          </button>
        ) : (
          <span />
        )}
        {!off && <span className="ml-auto text-[11px] text-faint tabular">{t("lag.card.took", { ms: s.tookMs })}</span>}
      </div>
    </div>
  );
}

function EventRow({ ev, open, onToggle }: { ev: LagEvent; open: boolean; onToggle: () => void }) {
  const t = useT();
  const Icon = CAUSE_ICONS[ev.cause];
  return (
    <div className={cn("rounded-xl border transition-colors", open ? "border-line-strong bg-surface-2/60" : "border-line bg-surface/40")}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-3" style={{ color: CAUSE_TONE[ev.cause] }}>
          <Icon className="h-4.5 w-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-fg">{capitalizeFirst(causeLine(ev.cause, ev.targetKind, t))}</span>
            {ev.cause !== "unknown" && <span className="shrink-0 rounded-full bg-surface-3 px-1.5 py-px text-[9px] font-semibold tracking-[0.08em] text-muted uppercase">{t("lag.estimate")}</span>}
            {ev.count > 1 && <span className="shrink-0 rounded-full bg-accent/15 px-2 py-px text-[10px] font-semibold text-accent tabular">{t("lag.card.count", { n: ev.count })}</span>}
          </div>
          <div className="truncate text-[12px] text-muted tabular">
            {formatTime(ev.at, true)} · {ev.targetLabel} · {t("lag.card.spike", { rtt: Math.round(ev.rtt), baseline: Math.round(ev.baseline) })}
          </div>
        </div>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted transition-transform duration-200", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <EventDetails ev={ev} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function LagCard() {
  const t = useT();
  const events = useLag((s) => s.events);
  const snapshotsOn = useSettings((s) => s.settings.lag?.snapshots ?? true);
  // `null` = noch nichts gewählt → das neueste Ereignis ist aufgeklappt
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    void useLag.getState().init();
  }, []);
  const activeKey = closed ? null : (openKey ?? (events[0] ? keyOf(events[0]) : null));
  return (
    <section className="glass rounded-xl p-5" data-testid="lag-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-surface-2 text-accent">
            <Siren className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-fg">{t("lag.title")}</h2>
            <p className="text-[12px] text-muted">{t("lag.subtitle")}</p>
          </div>
        </div>
        {events.length > 0 && <div className="max-w-full text-[12px] text-fg-soft tabular">{causeSummary(countsFromEvents(events), t)}</div>}
      </div>
      {!snapshotsOn && <div className="mt-4 rounded-lg bg-warning/10 px-3 py-2 text-[12px] text-warning">{t("lag.card.snapshotsOff")}</div>}
      {events.length === 0 ? (
        <div className="mt-4 rounded-lg bg-surface px-4 py-5 text-[13px] text-muted">{t("lag.card.empty")}</div>
      ) : (
        <>
          <div className="mt-4 px-1 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{t("lag.card.recent")}</div>
          <div className="mt-2 flex flex-col gap-2">
            {events.map((ev) => {
              const k = keyOf(ev);
              const open = activeKey === k;
              return (
                <EventRow
                  key={k}
                  ev={ev}
                  open={open}
                  onToggle={() => {
                    if (open) {
                      setClosed(true);
                    } else {
                      setClosed(false);
                      setOpenKey(k);
                    }
                  }}
                />
              );
            })}
          </div>
        </>
      )}
      <p className="mt-4 flex gap-2 text-[11px] leading-relaxed text-muted">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {t("lag.card.honest")}
      </p>
    </section>
  );
}
