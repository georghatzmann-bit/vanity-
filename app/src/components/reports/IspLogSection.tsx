/**
 * Berichte › Anbieter-Protokoll (`section: "isp"`): Aussetzer, Verlust-Fenster, langsame Minuten und
 * Speedtests eines Netzes mit Uhrzeit, Tagesbalken, Ereignisliste und Export als HTML/CSV – mit dem
 * Hinweis auf die Breitbandmessung der Bundesnetzagentur. Ein Indiz, kein Nachweis.
 * Vertrag: docs/API.md, „Anbieter-Protokoll“. Rechnung in `lib/isplog.ts`.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { ExternalLink, FileDown, FileSpreadsheet, Gauge, Globe, Hourglass, Info, Loader2, RefreshCw, ScrollText, TriangleAlert, Unplug, WifiOff } from "lucide-react";
import { api, errorText } from "@/lib/api";
import { CSV_FILTER, exportText, HTML_FILTER, ispLogFileName } from "@/lib/exportfile";
import { useLanguage, useT } from "@/lib/i18n";
import {
  basisText,
  BNETZA_STAND,
  BNETZA_URL,
  buildIspLog,
  DEFAULT_ISP_RANGE,
  dateTimeText,
  dayKey,
  dayText,
  defaultNetId,
  durationText,
  fmtNum,
  ISP_LIST_KINDS,
  ISP_LIST_LIMIT,
  ISP_RANGES,
  ispRange,
  netChoices,
  netName,
  otherNetsText,
  spikeText,
  translator,
  vpnShareText,
  wifiShareText,
  zoneText,
} from "@/lib/isplog";
import { defaultTimeZone } from "@/lib/localtime";
import { backendText } from "@/lib/netauto";
import { defaultIspLog } from "@/lib/settings/isplog";
import type { EventSummaryRow, EventsPage, HourlyRow, IspLogDay, IspLogRange, IspLogResult, IspLogRow, Language } from "@/lib/types";
import { useSettings } from "@/store/settings";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { Button } from "@shared/ui/Button";
import { staggerContainer, staggerItem } from "@shared/design/motion";
import { cn } from "@shared/lib/cn";

/** So viele Ereignisse zeigt die Liste (Bericht und CSV enthalten alle) */
const UI_ROWS = 200;
const DAY_MS = 86_400_000;

interface Base {
  from: number;
  to: number;
  hourly: HourlyRow[];
  summary: EventSummaryRow[];
}

export function IspLogSection() {
  const t = useT();
  const lang: Language = useLanguage() === "en" ? "en" : "de";
  const contract = useSettings((s) => s.settings.ispLog) ?? defaultIspLog();
  const [range, setRange] = useState<IspLogRange>(DEFAULT_ISP_RANGE);
  const [base, setBase] = useState<Base | null>(null);
  const [netId, setNetId] = useState<string | null>(null);
  const [page, setPage] = useState<(EventsPage & { netId: string; from: number }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const timeZone = useMemo(() => defaultTimeZone(), []);

  // Stunden-Summen und Zählungen aller Netze (für Netz-Auswahl und Hinweis „andere Netze“)
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    const { from, to } = ispRange(range);
    Promise.all([api.historyHourly(from, to), api.eventsSummary(from, to)])
      .then(([hourly, summary]) => {
        if (!alive) return;
        setBase({ from, to, hourly, summary });
        setNetId((prev) => (prev !== null && netChoices(hourly, summary).some((c) => c.netId === prev) ? prev : defaultNetId(hourly, summary)));
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(errorText(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [range, reload]);

  // Ereignisse des gewählten Netzes (ohne Ausreißer – die zählt `net_events_summary`)
  useEffect(() => {
    if (!base) return;
    if (netId === null) {
      setPage(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    api
      .eventsList(base.from, base.to, [...ISP_LIST_KINDS], netId, ISP_LIST_LIMIT)
      .then((p) => alive && setPage({ ...p, netId, from: base.from }))
      .catch((e: unknown) => alive && setError(errorText(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [base, netId]);

  const report = useMemo<IspLogResult | null>(() => {
    if (!base || netId === null || !page || page.netId !== netId || page.from !== base.from) return null;
    return buildIspLog({ events: page.events, truncated: page.truncated, summary: base.summary, hourly: base.hourly, from: base.from, to: base.to, netId, contract, lang, timeZone });
  }, [base, netId, page, contract, lang, timeZone]);

  const errorLine = error && (
    <div className="glass flex flex-wrap items-center gap-3 rounded-xl px-5 py-4 text-sm text-fg-soft">
      <TriangleAlert className="h-5 w-5 shrink-0 text-warning" />
      <span className="min-w-0 flex-1">{t("ispLog.loadFailed", { value: backendText(error, t) })}</span>
      <Button size="sm" icon={<RefreshCw className="h-4 w-4" />} onClick={() => setReload((n) => n + 1)}>
        {t("ispLog.retry")}
      </Button>
    </div>
  );

  if (!base) {
    return (
      errorLine || (
        <div className="flex items-center gap-2 px-1 py-10 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("ispLog.loading")}
        </div>
      )
    );
  }

  const noData = netId === null;
  return (
    <motion.div variants={staggerContainer(0.04)} initial="initial" animate="enter" className="space-y-4" data-testid="isp-log-section">
      <motion.p variants={staggerItem} className="max-w-3xl text-sm text-muted">
        {t("ispLog.intro")}
      </motion.p>
      <motion.div variants={staggerItem}>
        <Filters base={base} netId={netId} range={range} lang={lang} loading={loading} onNet={setNetId} onRange={setRange} report={report} />
      </motion.div>
      {errorLine}
      {noData ? (
        <EmptyState icon={<ScrollText className="h-7 w-7" />} title={t("ispLog.empty")} text={t("ispLog.emptyText")} />
      ) : !report ? (
        <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("ispLog.loading")}
        </div>
      ) : (
        <>
          <motion.div variants={staggerItem}>
            <Notes report={report} lang={lang} />
          </motion.div>
          <motion.div variants={staggerItem}>
            <Kpis report={report} lang={lang} />
          </motion.div>
          <motion.div variants={staggerItem}>
            <DayBars report={report} lang={lang} timeZone={timeZone} />
          </motion.div>
          <motion.div variants={staggerItem}>
            <EventList rows={report.rows} lang={lang} timeZone={timeZone} />
          </motion.div>
        </>
      )}
      <motion.div variants={staggerItem}>
        <BnetzaBox showTicket={!!report && report.totals.internetOutages > 0} />
      </motion.div>
      <motion.div variants={staggerItem} className="flex items-start gap-2 text-[12px] leading-relaxed text-muted">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="max-w-4xl">
          {t("ispLog.otherDevices")} {t("ispLog.report.honest")}
        </span>
      </motion.div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------------------------
// Auswahl und Export
// ---------------------------------------------------------------------------------------------

function Filters({ base, netId, range, lang, loading, onNet, onRange, report }: { base: Base; netId: string | null; range: IspLogRange; lang: Language; loading: boolean; onNet: (id: string) => void; onRange: (r: IspLogRange) => void; report: IspLogResult | null }) {
  const t = useT();
  const choices = useMemo(() => netChoices(base.hourly, base.summary), [base]);
  const hours = (ms: number) => fmtNum(Math.round(ms / 360_000) / 10, 1, lang);
  const save = (kind: "html" | "csv") => {
    if (!report) return;
    void exportText(ispLogFileName(base.from, base.to, kind), kind === "html" ? HTML_FILTER : CSV_FILTER, kind === "html" ? report.html : report.csv);
  };
  return (
    <div className="glass flex flex-wrap items-end gap-x-4 gap-y-3 rounded-xl px-4 py-3">
      {choices.length > 0 && netId !== null && (
        <Labeled label={t("ispLog.filter.net")} className="w-[17rem] max-w-full" title={t("ispLog.netHint")}>
          <Select value={netId} onChange={onNet} options={choices.map((c) => ({ value: c.netId, label: t("ispLog.netOption", { name: netName(c, t), hours: hours(c.coveredMs) }) }))} />
        </Labeled>
      )}
      <Labeled label={t("ispLog.filter.range")}>
        <div className="flex items-center gap-2">
          <Segmented size="sm" value={String(range)} onChange={(v) => onRange(Number(v) as IspLogRange)} options={ISP_RANGES.map((r) => ({ value: String(r), label: t("ispLog.range", { n: r }) }))} />
          {loading && <Loader2 className="h-4 w-4 animate-spin text-muted" />}
        </div>
      </Labeled>
      <div className="ml-auto flex flex-wrap gap-2" title={t("ispLog.save.printHint")}>
        <Button size="sm" variant="primary" disabled={!report} icon={<FileDown className="h-4 w-4" />} onClick={() => save("html")} data-testid="isp-save-html">
          {t("ispLog.save.html")}
        </Button>
        <Button size="sm" disabled={!report} icon={<FileSpreadsheet className="h-4 w-4" />} onClick={() => save("csv")} data-testid="isp-save-csv">
          {t("ispLog.save.csv")}
        </Button>
      </div>
    </div>
  );
}

function Labeled({ label, children, className, title }: { label: string; children: ReactNode; className?: string; title?: string }) {
  return (
    <div className={className} title={title}>
      <div className="mb-1.5 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{label}</div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Kopf: Datenbasis, WLAN-/VPN-Anteil, andere Netze, gekappt
// ---------------------------------------------------------------------------------------------

function Notes({ report, lang }: { report: IspLogResult; lang: Language }) {
  const t = useT();
  const h = report.header;
  const tr = translator(lang);
  const warnings = [wifiShareText(h.wifiShare, tr, lang), vpnShareText(h.vpnShare, tr, lang), otherNetsText(h.otherNets, tr), h.truncated ? t("ispLog.truncated") : null].filter((x): x is string => !!x);
  return (
    <div className="glass space-y-1.5 rounded-xl px-5 py-3 text-[13px] text-fg-soft">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-fg">{basisText(h, tr, lang)}</span>
        <span className="text-muted">{zoneText(h.timeZone, h.utcOffset)}</span>
        {h.targets.length > 0 && <span className="text-muted">· {h.targets.map((x) => `${x.label} (${x.methodText})`).join(", ")}</span>}
      </div>
      {warnings.map((w) => (
        <div key={w} className="flex items-start gap-2 text-warning">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{w}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Kennzahlen
// ---------------------------------------------------------------------------------------------

function Kpis({ report, lang }: { report: IspLogResult; lang: Language }) {
  const t = useT();
  const tot = report.totals;
  const tr = translator(lang);
  const cards: { key: string; icon: ReactNode; label: string; value: number; sub: string; tone?: "danger" }[] = [
    { key: "internet", icon: <Globe className="h-4 w-4" />, label: t("ispLog.kpi.internet"), value: tot.internetOutages, sub: t("ispLog.kpi.internetSub", { duration: durationText(tot.internetOutageS, tr) }), tone: tot.internetOutages > 0 ? "danger" : undefined },
    { key: "other", icon: <Unplug className="h-4 w-4" />, label: t("ispLog.kpi.other"), value: tot.otherOutages, sub: t("ispLog.kpi.otherSub") },
    { key: "loss", icon: <WifiOff className="h-4 w-4" />, label: t("ispLog.kpi.loss"), value: tot.lossWindows, sub: t("ispLog.kpi.lossSub") },
    { key: "slow", icon: <Hourglass className="h-4 w-4" />, label: t("ispLog.kpi.slow"), value: tot.slowMinutes, sub: t("ispLog.kpi.slowSub") },
    { key: "speed", icon: <Gauge className="h-4 w-4" />, label: t("ispLog.kpi.speedtests"), value: tot.speedtests, sub: tot.downMedian === null ? t("ispLog.kpi.speedtestsNone") : t("ispLog.kpi.speedtestsSub", { down: fmtNum(tot.downMedian, 1, lang) }) },
  ];
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {cards.map((c) => (
          <div key={c.key} className="glass rounded-xl px-4 py-3" data-testid={`isp-kpi-${c.key}`}>
            <div className="flex min-h-[2rem] items-start gap-2 text-[12px] leading-tight text-muted">
              <span className={cn("mt-px text-accent", c.tone === "danger" && "text-danger")}>{c.icon}</span>
              <span className="line-clamp-2" title={c.label}>
                {c.label}
              </span>
            </div>
            <div className={cn("mt-1 text-2xl font-semibold text-fg tabular", c.tone === "danger" && "text-danger")}>{c.value}</div>
            <div className="line-clamp-2 text-[11.5px] leading-snug text-muted" title={c.sub}>
              {c.sub}
            </div>
          </div>
        ))}
      </div>
      <p className="px-1 text-[12.5px] text-fg-soft">{spikeText(tot.spikesByCause, tr)}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Tagesbalken (Ortszeit; Tage ohne Messung bleiben leer – Lücken sind Lücken)
// ---------------------------------------------------------------------------------------------

function DayBars({ report, lang, timeZone }: { report: IspLogResult; lang: Language; timeZone: string }) {
  const t = useT();
  const tr = translator(lang);
  const { from, to } = report.header;
  const byDate = useMemo(() => new Map(report.days.map((d) => [d.date, d])), [report]);
  const dates = useMemo(() => {
    const out: string[] = [];
    for (let ms = from; ms <= to + DAY_MS; ms += DAY_MS / 2) {
      const k = dayKey(Math.min(ms, to), timeZone);
      if (!out.includes(k)) out.push(k);
    }
    return out;
  }, [from, to, timeZone]);
  return (
    <section className="glass rounded-xl px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg">{t("ispLog.days.bars")}</h3>
        <span className="text-[11.5px] text-muted">{t("ispLog.days.barsHint")}</span>
      </div>
      <div className="mt-3 flex h-28 items-end gap-[3px]" data-testid="isp-day-bars">
        {dates.map((date) => {
          const d: IspLogDay | undefined = byDate.get(date);
          const hours = d?.measuredHours ?? 0;
          const problems = d ? d.internetOutages : 0;
          return (
            <div key={date} className="group relative flex h-full min-w-0 flex-1 flex-col justify-end" title={t("ispLog.days.tip", { date: dayText(date, tr, lang), hours, internet: problems })}>
              {problems > 0 && <span className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rounded-full bg-danger" />}
              <div className={cn("w-full rounded-t-[3px] transition-colors", hours > 0 ? "bg-accent/60 group-hover:bg-accent" : "bg-line")} style={{ height: `${Math.max(hours > 0 ? 6 : 2, (hours / 24) * 100)}%` }} />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-muted tabular">
        <span>{dates[0] ? dayText(dates[0], tr, lang) : ""}</span>
        <span>{dates.length ? dayText(dates[dates.length - 1], tr, lang) : ""}</span>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Ereignisliste (neueste zuerst; Ausreißer nur gezählt)
// ---------------------------------------------------------------------------------------------

function EventList({ rows, lang, timeZone }: { rows: IspLogRow[]; lang: Language; timeZone: string }) {
  const t = useT();
  const shown = useMemo(() => rows.slice(-UI_ROWS).reverse(), [rows]);
  return (
    <section className="glass rounded-xl px-5 py-4">
      <h3 className="text-sm font-semibold text-fg">{t("ispLog.list.title")}</h3>
      {!rows.length ? (
        <p className="mt-2 text-[13px] text-muted">{t("ispLog.list.none")}</p>
      ) : (
        <div className="mt-2 max-h-[22rem] overflow-auto">
          <table className="w-full text-left text-[12.5px]" data-testid="isp-event-list">
            <thead className="sticky top-0 z-[1] bg-[var(--nv-bg-elev)] text-[11px] tracking-wide text-muted uppercase">
              <tr>
                <th className="px-2 py-1.5 font-semibold">{t("ispLog.list.time")}</th>
                <th className="px-2 py-1.5 font-semibold">{t("ispLog.list.kind")}</th>
                <th className="px-2 py-1.5 font-semibold">
                  {t("ispLog.list.target")} · {t("ispLog.list.connection")}
                </th>
                <th className="px-2 py-1.5 font-semibold">{t("ispLog.list.value")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {shown.map((r) => {
                const target = r.kind === "speedtest" || r.kind === "quiet" ? "" : (r.targetLabel ?? "");
                const conn = r.kind === "quiet" ? "" : t(`ispLog.conn.${r.connection ?? "unknown"}`);
                return (
                  <tr key={`${r.id}-${r.t}`} className={cn("align-top text-fg-soft", r.connection === "vpn" && "bg-accent/5")}>
                    <td className="px-2 py-1.5 whitespace-nowrap tabular">{dateTimeText(r.t, timeZone, lang, true)}</td>
                    <td className="px-2 py-1.5">
                      <div className="whitespace-nowrap text-fg">{t(`ispLog.kind.${r.kind}`)}</div>
                      {r.scope && <div className={cn("text-[11.5px] text-muted", r.scope === "internet" && "font-semibold text-danger")}>{t(`ispLog.scope.${r.scope}`)}</div>}
                    </td>
                    <td className="max-w-[14rem] px-2 py-1.5">
                      <div className="truncate" title={target}>
                        {target}
                      </div>
                      <div className="text-[11.5px] text-muted">{conn}</div>
                    </td>
                    <td className="px-2 py-1.5">{r.text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > UI_ROWS && <p className="mt-2 text-[12px] text-muted">{t("ispLog.list.uiMore", { n: UI_ROWS })}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Hinweis-Kasten Breitbandmessung (immer sichtbar)
// ---------------------------------------------------------------------------------------------

function BnetzaBox({ showTicket }: { showTicket: boolean }) {
  const t = useT();
  return (
    <section className="rounded-xl border border-warning/50 bg-warning/10 px-5 py-4" data-testid="isp-bnetza">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
        <Info className="h-4 w-4 text-warning" />
        {t("ispLog.bnetza.title")}
      </h3>
      <p className="mt-2 max-w-5xl text-[13px] leading-relaxed text-fg-soft">{t("ispLog.bnetza.text", { stand: BNETZA_STAND })}</p>
      {showTicket && <p className="mt-2 text-[13px] font-medium text-fg">{t("ispLog.bnetza.ticket")}</p>}
      <div className="mt-3">
        <Button size="sm" icon={<ExternalLink className="h-4 w-4" />} onClick={() => void api.openUrl(BNETZA_URL).catch(() => undefined)}>
          {t("ispLog.bnetza.open")}
        </Button>
      </div>
    </section>
  );
}
