/**
 * Berichte › Kalender: Heatmap Wochentag × Stunde aus den gespeicherten Stunden-Summen und – nur bei
 * genug Daten und deutlichem Unterschied – „Bisher am ruhigsten …“. Keine Vorhersage.
 * Vertrag: docs/API.md, „Pulsar-Kalender“. Rechnung in `lib/calendar.ts`.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { CalendarDays, Hourglass, Info, Loader2, RefreshCw, Scale, Sparkles, TriangleAlert } from "lucide-react";
import { api, errorText } from "@/lib/api";
import {
  adviceTexts,
  basisText,
  CALENDAR_RANGES,
  calendarModel,
  coveredHours,
  DEFAULT_RANGE,
  defaultFilter,
  filterRows,
  formatHours,
  formatNum,
  netOptions,
  rangeFor,
  reconcileFilter,
  targetOptions,
  whenText,
  type CalendarFilter,
  type CalendarModel,
  type NetOption,
} from "@/lib/calendar";
import { gradeColor } from "@/lib/grade";
import { useLanguage, useT } from "@/lib/i18n";
import { backendText } from "@/lib/netauto";
import type { CalendarCell, CalendarConnectionFilter, CalendarRange, Grade, HourlyRow } from "@/lib/types";
import { Heatmap, thinBackground, type HeatCell } from "@/components/charts/Heatmap";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { Button } from "@shared/ui/Button";
import { staggerContainer, staggerItem } from "@shared/design/motion";

type Lang = "de" | "en";
type T = ReturnType<typeof useT>;
const CONNECTIONS: CalendarConnectionFilter[] = ["noVpn", "ethernet", "wifi"];
const GRADES: Grade[] = ["A+", "A", "B", "C", "D", "F"];
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

export function CalendarSection() {
  const t = useT();
  const lang: Lang = useLanguage() === "de" ? "de" : "en";
  const [range, setRange] = useState<CalendarRange>(DEFAULT_RANGE);
  const [rows, setRows] = useState<HourlyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<CalendarFilter | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    const { from, to } = rangeFor(range);
    api
      .historyHourly(from, to)
      .then((r) => {
        if (!alive) return;
        setRows(r);
        setFilter((f) => (f ? reconcileFilter(r, f) : defaultFilter(r)));
      })
      .catch((e: unknown) => {
        if (alive) setError(errorText(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [range, reload]);

  const model = useMemo(() => (rows && filter ? calendarModel(filterRows(rows, filter)) : null), [rows, filter]);
  const errorLine = error && (
    <div className="glass flex flex-wrap items-center gap-3 rounded-xl px-5 py-4 text-sm text-fg-soft">
      <TriangleAlert className="h-5 w-5 shrink-0 text-warning" />
      <span className="min-w-0 flex-1">{t("calendar.loadFailed", { value: backendText(error, t) })}</span>
      <Button size="sm" icon={<RefreshCw className="h-4 w-4" />} onClick={() => setReload((n) => n + 1)}>
        {t("calendar.retry")}
      </Button>
    </div>
  );

  if (!rows || !filter || !model) {
    return (
      errorLine || (
        <div className="flex items-center gap-2 px-1 py-10 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("calendar.loading")}
        </div>
      )
    );
  }

  const nothingSelected = model.cells.every((c) => c.n === 0);
  return (
    <motion.div variants={staggerContainer(0.04)} initial="initial" animate="enter" className="space-y-4" data-testid="calendar-section">
      <motion.p variants={staggerItem} className="max-w-3xl text-sm text-muted">
        {t("calendar.intro")}
      </motion.p>
      <motion.div variants={staggerItem}>
        <Filters rows={rows} filter={filter} range={range} lang={lang} loading={loading} onFilter={setFilter} onRange={setRange} />
      </motion.div>
      {errorLine}
      {!rows.length ? (
        <EmptyState icon={<CalendarDays className="h-7 w-7" />} title={t("calendar.empty")} text={t("calendar.emptyText")} />
      ) : nothingSelected ? (
        <motion.div variants={staggerItem} className="glass rounded-xl px-5 py-6 text-sm text-fg-soft">
          {t("calendar.emptyFilter")}
        </motion.div>
      ) : (
        <>
          <motion.div variants={staggerItem}>
            <AdviceCard model={model} lang={lang} />
          </motion.div>
          <motion.div variants={staggerItem}>
            <HeatmapCard model={model} lang={lang} />
          </motion.div>
        </>
      )}
      <motion.div variants={staggerItem} className="flex items-start gap-2 text-[12px] leading-relaxed text-muted">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="max-w-4xl">{t("calendar.honest")}</span>
      </motion.div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------------------------

const shortDate = (ms: number, lang: Lang) => new Date(ms).toLocaleDateString(lang === "de" ? "de-DE" : "en-GB", { day: "numeric", month: "short" });

const netName = (o: NetOption, t: T) => (o.index > 0 ? t("calendar.netName", { n: o.index }) : t("calendar.netUnknown"));

function Filters({ rows, filter, range, lang, loading, onFilter, onRange }: { rows: HourlyRow[]; filter: CalendarFilter; range: CalendarRange; lang: Lang; loading: boolean; onFilter: (f: CalendarFilter) => void; onRange: (r: CalendarRange) => void }) {
  const t = useT();
  const targets = useMemo(() => targetOptions(rows), [rows]);
  const nets = useMemo(() => netOptions(rows, filter.targetKey), [rows, filter.targetKey]);
  const hours = (ms: number) => formatHours(coveredHours(ms), lang);

  const pickTarget = (targetKey: string) => {
    const options = netOptions(rows, targetKey);
    const netId = options.some((n) => n.netId === filter.netId) ? filter.netId : (options[0]?.netId ?? null);
    onFilter({ ...filter, targetKey, netId });
  };

  return (
    <div className="glass flex flex-wrap items-end gap-x-4 gap-y-3 rounded-xl px-4 py-3">
      {targets.length > 0 && (
        <Labeled label={t("calendar.filter.target")} className="w-[17rem] max-w-full">
          <Select value={filter.targetKey ?? ""} onChange={pickTarget} options={targets.map((o) => ({ value: o.key, label: t("calendar.targetOption", { label: o.label, kind: t(`calendar.kind.${o.kind}`), hours: hours(o.coveredMs) }) }))} />
        </Labeled>
      )}
      {nets.length > 0 && (
        <Labeled label={t("calendar.filter.net")} className="w-[19rem] max-w-full" title={t("calendar.netHint")}>
          <Select
            value={filter.netId ?? ""}
            onChange={(netId) => onFilter({ ...filter, netId })}
            options={nets.map((o) => ({ value: o.netId, label: t("calendar.netOption", { name: netName(o, t), from: shortDate(o.from, lang), to: shortDate(o.to, lang), hours: hours(o.coveredMs) }) }))}
          />
        </Labeled>
      )}
      <Labeled label={t("calendar.filter.connection")}>
        <Segmented size="sm" value={filter.connection} onChange={(connection) => onFilter({ ...filter, connection })} options={CONNECTIONS.map((c) => ({ value: c, label: t(`calendar.conn.${c}`) }))} />
      </Labeled>
      <Labeled label={t("calendar.filter.range")}>
        <div className="flex items-center gap-2">
          <Segmented size="sm" value={String(range)} onChange={(v) => onRange(Number(v) as CalendarRange)} options={CALENDAR_RANGES.map((r) => ({ value: String(r), label: t("calendar.range", { n: r }) }))} />
          {loading && <Loader2 className="h-4 w-4 animate-spin text-muted" />}
        </div>
      </Labeled>
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
// Empfehlung
// ---------------------------------------------------------------------------------------------

function AdviceCard({ model, lang }: { model: CalendarModel; lang: Lang }) {
  const t = useT();
  const texts = adviceTexts(model, t, lang);
  const icon = texts.kind === "best" ? <Sparkles className="h-5 w-5" /> : texts.kind === "noDifference" ? <Scale className="h-5 w-5" /> : <Hourglass className="h-5 w-5" />;
  const tone = texts.kind === "best" ? "text-success" : texts.kind === "noDifference" ? "text-accent" : "text-muted";
  return (
    <div className="glass flex items-start gap-4 rounded-xl p-5" data-testid="calendar-advice" data-kind={texts.kind}>
      <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-line bg-surface-2 ${tone}`}>{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold text-fg">{texts.title}</div>
        <div className="mt-0.5 text-[13px] text-muted">{texts.sub}</div>
        {texts.worst && (
          <div className="mt-2 flex items-start gap-1.5 text-[13px] text-fg-soft">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
            {texts.worst}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------------------------------

const cellState = (c: CalendarCell): HeatCell["state"] => (c.n === 0 ? "empty" : c.valid ? "full" : "thin");

function HeatmapCard({ model, lang }: { model: CalendarModel; lang: Lang }) {
  const t = useT();
  const best = model.advice.kind === "best" ? model.advice.best : null;
  const heat: HeatCell[] = model.cells.map((c) => {
    const state = cellState(c);
    const stateText = state === "empty" ? t("calendar.tip.none") : state === "thin" ? t("calendar.legend.thin") : (c.grade ?? "–");
    return {
      color: c.n > 0 ? gradeColor(c.grade) : null,
      state,
      label: t("calendar.cellLabel", { when: whenText(c.weekday, c.hour, t, 1), state: stateText }),
      highlight: best !== null && c.weekday === best.weekday && (c.hour === best.hour || c.hour === best.hour + 1),
    };
  });
  return (
    <div className="glass rounded-xl p-5" data-testid="calendar-heatmap">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{t("calendar.title")}</div>
        <div className="text-[12px] text-muted tabular">{basisText(model.basis, t, lang)}</div>
      </div>
      <Heatmap
        cells={heat}
        rowLabels={WEEKDAYS.map((d) => t(`calendar.weekday.${d}`))}
        colLabels={HOURS.map((h) => (h % 2 === 0 ? String(h) : null))}
        label={t("calendar.title")}
        tooltip={(i) => <CellTooltip cell={model.cells[i]} lang={lang} />}
      />
      <Legend />
    </div>
  );
}

function CellTooltip({ cell, lang }: { cell: CalendarCell; lang: Lang }) {
  const t = useT();
  const when = whenText(cell.weekday, cell.hour, t, 1);
  if (cell.n === 0) {
    return (
      <>
        <div className="font-semibold">{when}</div>
        <div className="text-muted">{t("calendar.tip.none")}</div>
      </>
    );
  }
  const ms = (v: number | null) => (v === null ? "–" : `${formatNum(v, 1, lang)} ms`);
  const pct = (v: number) => `${formatNum(v * 100, 1, lang)} %`;
  const lines: [string, string][] = [
    [t("calendar.tip.avg"), ms(cell.avg)],
    [t("calendar.tip.jitter"), ms(cell.jitter)],
    [t("calendar.tip.loss"), pct(cell.loss)],
    [t("calendar.tip.spikes"), pct(cell.spikeRate)],
    [t("calendar.tip.covered"), `${formatHours(coveredHours(cell.covered), lang)} h`],
    [t("calendar.tip.days"), String(cell.days)],
  ];
  return (
    <>
      <div className="mb-1 flex items-center justify-between gap-3 font-semibold">
        <span>{when}</span>
        {cell.valid && cell.grade && (
          <span className="rounded px-1.5 text-[11px] font-bold" style={{ color: gradeColor(cell.grade), background: `color-mix(in oklab, ${gradeColor(cell.grade)} 16%, transparent)` }}>
            {cell.grade}
          </span>
        )}
      </div>
      <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
        {lines.map(([k, v]) => (
          <div key={k} className="contents">
            <span className="text-muted">{k}</span>
            <span className="text-right tabular">{v}</span>
          </div>
        ))}
      </div>
      {!cell.valid && <div className="mt-1.5 text-[11px] text-warning">{t("calendar.tip.thin")}</div>}
    </>
  );
}

function Legend() {
  const t = useT();
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-muted">
      <div className="flex items-center gap-1.5">
        {GRADES.map((g) => (
          <span key={g} className="grid h-[18px] min-w-[26px] place-items-center rounded-[4px] px-1 text-[10px] font-bold text-white" style={{ background: `color-mix(in oklab, ${gradeColor(g)} 82%, transparent)` }}>
            {g}
          </span>
        ))}
      </div>
      <span className="flex items-center gap-1.5">
        <span className="h-[14px] w-[18px] rounded-[4px]" style={{ background: thinBackground(gradeColor("A")) }} />
        {t("calendar.legend.thin")}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-[14px] w-[18px] rounded-[4px] border border-dashed border-line" />
        {t("calendar.legend.none")}
      </span>
    </div>
  );
}
