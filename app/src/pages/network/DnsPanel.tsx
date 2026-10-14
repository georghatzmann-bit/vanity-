/** Netzwerk › DNS: Vergleich und Einstellen des DNS (aus pages/Network.tsx ausgelagert). */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { Activity, AlertTriangle, Check, ExternalLink, Globe, Info, RotateCcw, Router, ShieldCheck, Zap } from "lucide-react";
import { api, errorText, listen } from "@/lib/api";
import { t, useT } from "@/lib/i18n";
import { DNS_PROVIDERS, backendText, dnsScore, isDeclined, isManualProvider, mayBeChanged, pickBestDns, providerName, type DnsPick } from "@/lib/netauto";
import type { DnsConfig, DnsProgress, DnsResult } from "@/lib/types";
import { dnsChangePossible, dnsLabel, useNetAuto, withWindowsLock } from "@/store/netauto";
import { toast } from "@/store/ui";
import { Button } from "@shared/ui/Button";
import { ProgressBar } from "@shared/ui/ProgressBar";
import { cn } from "@shared/lib/cn";
import { sound } from "@shared/sound/engine";

/** Hinweis zu einem DNS-Dienst (z. B. „blockiert Werbung“) */
function dnsNote(id: string): string | null {
  const note = DNS_PROVIDERS.find((p) => p.id === id)?.note;
  return note ? t(`network.dns.notes.${note}`) : null;
}

/**
 * Band nach dem DNS-Vergleich: Vorschlag, „schon schnell“, „keine Daten“ oder „nicht gemessen“.
 * Ehrlich: kein Wechselvorschlag ohne Messung des jetzigen DNS, bewusst gewählte Dienste nur mit Hinweis.
 */
function DnsAdvice({ pick, recommend, manualCurrent, fasterManual, canChange, button }: { pick: DnsPick; recommend: DnsResult | null; manualCurrent: string | null; fasterManual: DnsResult | null; canChange: boolean; button: ReactNode }) {
  const t = useT();
  const strong = !!recommend && !manualCurrent;
  let tone: "accent" | "warn" | "ok" | "info";
  let title: string;
  let text: ReactNode;
  if (pick.reason === "notMeasured") {
    tone = "info";
    title = t("network.dns.notMeasured");
    text = t("network.dns.notMeasuredText");
  } else if (recommend) {
    tone = strong ? "accent" : "info";
    title = t("network.dns.recommend", { name: recommend.name });
    const gain = pick.bestScore !== null && pick.currentScore !== null ? t("network.dns.recommendText", { ms: Math.round(pick.bestScore), old: Math.round(pick.currentScore) }) : t("network.dns.recommendTextNoOld");
    text = manualCurrent ? `${t("network.dns.manualHint", { name: manualCurrent })} ${gain}` : `${gain} ${t("network.dns.uacShort")}`;
  } else if (pick.reason === "noData") {
    tone = "warn";
    title = t("network.dns.noData");
    text = t("network.dns.noDataText");
  } else if (!canChange && pick.change && pick.best) {
    tone = "info";
    title = t("network.dns.recommend", { name: pick.best.name });
    text = t("network.dns.recommendManual");
  } else {
    tone = "ok";
    title = t("network.dns.alreadyFast");
    text = fasterManual ? `${t("network.dns.alreadyFastText")} ${t("network.dns.fasterManual", { name: fasterManual.name })}` : t("network.dns.alreadyFastText");
  }
  const icon = { accent: <Zap className="h-5 w-5" />, warn: <AlertTriangle className="h-5 w-5" />, ok: <Check className="h-5 w-5" />, info: <Info className="h-5 w-5" /> }[tone];
  const iconCls = { accent: "bg-gradient-accent text-accent-fg", warn: "bg-warning/15 text-warning-fg", ok: "bg-success/15 text-success-fg", info: "bg-surface-3 text-accent-text" }[tone];
  return (
    <motion.div key={`${pick.reason}-${recommend?.id ?? ""}`} className={cn("mt-4 flex flex-wrap items-center gap-4 rounded-xl p-4", strong ? "ring-1 ring-accent/30" : "glass")} style={strong ? { background: "var(--nv-gradient-soft)" } : undefined} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }} role="status" aria-live="polite">
      <span className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-full", iconCls)} aria-hidden>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-fg">{title}</div>
        <div className="text-[12px] text-muted">{text}</div>
      </div>
      {button}
    </motion.div>
  );
}

export function DnsPanel() {
  const t = useT();
  const [results, setResults] = useState<DnsResult[]>([]);
  const [progress, setProgress] = useState<DnsProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState<DnsConfig | null>(null);
  const [loadingCurrent, setLoadingCurrent] = useState(true);
  /** Gerade laufende Änderung: Dienst-ID oder "restore" */
  const [working, setWorking] = useState<string | null>(null);

  useEffect(() => {
    void api
      .dnsCurrent()
      .then(setCurrent)
      .catch(() => setCurrent(null))
      .finally(() => setLoadingCurrent(false));
  }, []);

  const run = async () => {
    setRunning(true);
    setProgress({ done: 0, total: 8 });
    const un = await listen<DnsProgress>("net://dns", setProgress);
    try {
      setResults(await api.dnsBenchmark(5));
      sound.play("success");
    } catch (e) {
      toast({ kind: "error", title: t("toast.error"), text: errorText(e) });
    } finally {
      un();
      setRunning(false);
      setProgress(null);
    }
  };

  /**
   * Nach einer Änderung die Markierung „Aktuell“ im Vergleich anpassen (ohne neu zu messen).
   * Steht der neue DNS nicht im Vergleich (z. B. der Router, wenn beim Messen Cloudflare eingestellt war),
   * ist keine Zeile mehr „Aktuell“ – dann zeigt das Band „nicht gemessen“ statt eines falschen Vorschlags.
   */
  const markCurrent = (cfg: DnsConfig | null) => setResults((rs) => rs.map((r) => ({ ...r, current: cfg?.provider ? r.id === cfg.provider : r.id === "current" })));

  /** Nach jedem Versuch den echten Zustand zeigen – auch nach einem Fehler kann Windows etwas übernommen haben */
  const changed = async (cfg: DnsConfig | null | undefined) => {
    const fresh = cfg !== undefined ? cfg : await api.dnsCurrent().catch(() => undefined);
    if (fresh !== undefined) {
      setCurrent(fresh);
      markCurrent(fresh);
    }
    // Die Automatik-Karte darf danach kein altes Ergebnis mehr zeigen
    await useNetAuto.getState().externalChange();
  };

  const setProvider = (id: string) =>
    withWindowsLock(async () => {
      setWorking(id);
      let cfg: DnsConfig | undefined;
      try {
        cfg = await api.dnsApply(id);
        toast({ kind: "success", title: t("network.dns.setDone", { name: providerName(id) }), text: t("network.dns.setDoneText", { servers: cfg.servers.join(", ") }) });
      } catch (e) {
        const msg = errorText(e);
        if (isDeclined(msg)) toast({ kind: "info", title: t("network.dns.declined"), text: t("optimize.declinedText") });
        // Sicherung bleibt (Teilerfolg, Zeitüberschreitung): Windows kann schon geändert sein – nie „nicht geändert“
        else if (mayBeChanged(msg)) toast({ kind: "warning", title: t("network.dns.setUnsure"), text: backendText(msg, t) });
        else toast({ kind: "error", title: t("network.dns.setFailed"), text: backendText(msg, t) });
      } finally {
        await changed(cfg);
        setWorking(null);
      }
    });

  const restore = () =>
    withWindowsLock(async () => {
      setWorking("restore");
      // Nur wenn die Hauptverbindung selbst geändert war, passt „Wieder wie vorher: …“ zu ihren Servern
      const mainChanged = !!current?.changedByPulsar;
      let cfg: DnsConfig | null | undefined;
      try {
        cfg = (await api.dnsRestore()) ?? (await api.dnsCurrent().catch(() => null));
        // Steht danach noch eine Sicherung da, hat Windows den alten DNS (noch) nicht übernommen
        if (cfg?.changedByPulsar || (cfg?.otherBackups ?? []).length > 0) toast({ kind: "warning", title: t("network.dns.restoreIncomplete"), text: t("optimize.auto.restoreDnsLeft") });
        else toast({ kind: "success", title: t("network.dns.restored"), text: cfg && mainChanged ? t("network.dns.restoredText", { servers: cfg.dhcp ? t("network.dns.dhcp") : cfg.servers.join(", ") || "–" }) : undefined });
      } catch (e) {
        const msg = errorText(e);
        if (isDeclined(msg)) toast({ kind: "info", title: t("network.dns.declined"), text: t("optimize.declinedText") });
        else toast({ kind: "error", title: t("network.dns.restoreFailed"), text: backendText(msg, t) });
      } finally {
        await changed(cfg);
        setWorking(null);
      }
    });

  const pick = useMemo(() => pickBestDns(results), [results]);
  // Schnellster Eintrag nach Punktzahl (auch Dienste, die man nur von Hand wählt)
  const fastest = useMemo(() => {
    let best: DnsResult | null = null;
    let bestScore = Infinity;
    for (const r of results) {
      const sc = r.failed === 0 ? dnsScore(r) : null;
      if (sc !== null && sc < bestScore) {
        best = r;
        bestScore = sc;
      }
    }
    return best;
  }, [results]);
  const canChange = !!current?.canChange;
  const recommend = canChange && dnsChangePossible(pick, current) ? pick.best : null;
  // Bewusst gewählter Dienst (AdGuard, DNS0.eu, Mullvad): Vorschlag nur als Hinweis, nicht hervorgehoben
  const manualCurrent = isManualProvider(current?.provider) ? providerName(current?.provider) : null;
  // Schnellster insgesamt ist ein Dienst, den Pulsar nie automatisch wählt → ehrlich darauf hinweisen
  const fasterManual = canChange && fastest && pick.best && fastest !== pick.best && !fastest.current && isManualProvider(fastest.id) ? fastest : null;
  const howToTarget = pick.best ?? results.find((r) => r.uncachedMs !== null && !r.current) ?? null;
  const max = Math.max(1, ...results.map((r) => r.uncachedMs ?? 0));
  const canSet = (r: DnsResult) => canChange && r.id !== "current" && !r.current && r.id !== current?.provider && DNS_PROVIDERS.some((p) => p.id === r.id);
  // Läuft gerade „Netzwerk automatisch optimieren“, wartet diese Seite (sonst mischen sich zwei Vergleiche)
  const autoBusy = useNetAuto((st) => st.phase === "measuring" || st.phase === "applying");
  // Gemeinsame Sperre: Läuft irgendwo eine Änderung an Windows (auch auf der Optimieren-Seite), ist hier alles gesperrt
  const windowsBusy = useNetAuto((st) => st.windowsBusy);
  const locked = running || !!working || autoBusy || windowsBusy;

  return (
    <div className="mx-auto grid max-w-[1240px] grid-cols-1 gap-5 xl:grid-cols-[1.6fr_1fr]">
      <div className="min-w-0">
        <p className="text-[13px] text-muted">{t("network.dns.intro")}</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant={results.length ? "secondary" : "primary"} loading={running} disabled={!!working || autoBusy || windowsBusy} icon={<Activity className="h-4 w-4" />} onClick={() => void run()}>
            {running && progress ? t("network.dns.running", { done: progress.done, total: progress.total }) : results.length ? t("network.dns.runAgain") : t("network.dns.run")}
          </Button>
          {running && progress && <ProgressBar value={progress.done / Math.max(1, progress.total)} className="w-40" />}
        </div>
        {!results.length && !running && (
          <div className="glass mt-4 rounded-xl p-5">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-surface-2 text-accent">
                <Activity className="h-5 w-5" />
              </span>
              <div>
                <div className="text-sm font-semibold text-fg">{t("network.dns.notYet")}</div>
                <div className="text-[12px] text-muted">{t("network.dns.notYetText")}</div>
              </div>
            </div>
            <div className="mt-4 text-[10px] font-semibold tracking-[0.14em] text-muted uppercase">{t("network.dns.providers")}</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {[...DNS_PROVIDERS.map((p) => p.name), t("network.dns.yourRouter")].map((n) => (
                <span key={n} className="rounded-full border border-line bg-surface px-3 py-1 text-[12px] text-fg-soft">
                  {n}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Empfehlung nach dem Vergleich */}
        {results.length > 0 && !running && (
          <DnsAdvice
            pick={pick}
            recommend={recommend}
            manualCurrent={manualCurrent}
            fasterManual={fasterManual}
            canChange={canChange}
            button={
              recommend && (
                <Button variant={manualCurrent ? "secondary" : "primary"} icon={<Zap className="h-4 w-4" />} loading={working === recommend.id} disabled={locked && working !== recommend.id} onClick={() => void setProvider(recommend.id)}>
                  {t("network.dns.setNamed", { name: recommend.name })}
                </Button>
              )
            }
          />
        )}

        <div className="mt-3 flex flex-col gap-1.5">
          {results.map((r, i) => {
            const note = dnsNote(r.id);
            return (
              <motion.div key={r.id} className={cn("glass grid items-center gap-3 rounded-lg px-3 py-2.5", canChange ? "grid-cols-[minmax(0,1fr)_auto_auto_auto_auto]" : "grid-cols-[minmax(0,1fr)_auto_auto_auto]", r === fastest && "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--nv-success)_60%,transparent)]")} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-medium text-fg">
                    <span className="truncate">{r.name}</span>
                    {r === fastest && <span className="rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-semibold text-success-fg">{t("network.dns.fastest")}</span>}
                    {r === recommend && r !== fastest && <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold text-accent-text">{t("network.dns.recommended")}</span>}
                    {r.current && <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[10px] font-semibold text-fg-soft">{t("network.dns.current")}</span>}
                    {r.failed > 0 && <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning-fg">{t("network.dns.failedCount", { n: r.failed })}</span>}
                  </div>
                  <div className="text-[11px] text-muted tabular">
                    {r.primary}
                    {r.secondary ? ` · ${r.secondary}` : ""}
                    {note ? <span className="text-fg-soft"> · {note}</span> : null}
                  </div>
                </div>
                <div className="w-24 2xl:w-36">
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                    <motion.div className="h-full rounded-full bg-gradient-accent" initial={{ width: 0 }} animate={{ width: `${((r.uncachedMs ?? max) / max) * 100}%` }} />
                  </div>
                </div>
                <div className="w-16 text-right">
                  <div className="text-[10px] text-muted uppercase">{t("network.dns.uncached")}</div>
                  <div className="text-[13px] font-semibold text-fg tabular">{r.uncachedMs === null ? "✕" : `${r.uncachedMs.toFixed(0)} ms`}</div>
                </div>
                <div className="w-16 text-right">
                  <div className="text-[10px] text-muted uppercase">{t("network.dns.cached")}</div>
                  <div className="text-[13px] text-fg-soft tabular">{r.cachedMs === null ? "✕" : `${r.cachedMs.toFixed(0)} ms`}</div>
                </div>
                {canChange && (
                  <div className="flex w-[104px] justify-end">
                    {canSet(r) ? (
                      <Button size="sm" variant="secondary" loading={working === r.id} disabled={locked && working !== r.id} onClick={() => void setProvider(r.id)} aria-label={t("network.dns.setAria", { name: r.name })}>
                        {t("network.dns.set")}
                      </Button>
                    ) : r.current ? (
                      <span className="flex items-center gap-1 text-[11px] font-medium text-muted">
                        <Check className="h-3.5 w-3.5" aria-hidden /> {t("network.dns.inUse")}
                      </span>
                    ) : null}
                  </div>
                )}
              </motion.div>
            );
          })}
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        {/* Aktuelle Einstellung */}
        <div className="glass rounded-xl p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{t("network.dns.currentConfig")}</div>
            {/* Pulsar stellt nur bekannte Dienste ein – nur dann stimmt „Von Pulsar eingestellt“ */}
            {current?.changedByPulsar && !!current.provider && (
              <span className="inline-flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold text-accent-text">
                <ShieldCheck className="h-3 w-3" aria-hidden /> {t("network.dns.byPulsar")}
              </span>
            )}
          </div>
          {loadingCurrent ? (
            <div className="mt-3 space-y-2">
              <div className="skeleton h-6 w-40 rounded-md" />
              <div className="skeleton h-12 w-full rounded-lg" />
            </div>
          ) : current ? (
            <>
              <div className="mt-3 flex items-center gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-surface-2 text-accent">{current.provider ? <Globe className="h-5 w-5" /> : <Router className="h-5 w-5" />}</span>
                <div className="min-w-0">
                  <div className="truncate font-display text-lg font-bold text-fg">{dnsLabel(current)}</div>
                  <div className="truncate text-[12px] text-muted">
                    {current.adapter}
                    {current.dhcp ? ` · ${t("network.dns.dhcp")}` : ""}
                  </div>
                </div>
              </div>
              <dl className="mt-3 grid grid-cols-1 gap-2">
                <div className="min-w-0 rounded-lg bg-surface px-3 py-2">
                  <dt className="text-[10px] font-semibold tracking-[0.1em] text-muted uppercase">{t("network.dns.ipv4")}</dt>
                  <dd className="text-[13px] font-medium break-all text-fg tabular">{current.servers.join(", ") || "–"}</dd>
                </div>
                {(current.ipv6Servers ?? []).length > 0 && (
                  <div className="min-w-0 rounded-lg bg-surface px-3 py-2">
                    <dt className="text-[10px] font-semibold tracking-[0.1em] text-muted uppercase">{t("network.dns.ipv6")}</dt>
                    <dd className="text-[13px] font-medium break-all text-fg tabular">{current.ipv6Servers.join(", ")}</dd>
                  </div>
                )}
              </dl>
              {(current.changedByPulsar || (current.otherBackups ?? []).length > 0) && (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <p className="min-w-0 flex-1 text-[12px] leading-snug text-muted">
                    {current.changedByPulsar ? t("network.dns.restoreHint") : t("network.dns.otherBackups", { names: (current.otherBackups ?? []).join(", ") })}
                    {current.changedByPulsar && (current.otherBackups ?? []).length > 0 && <> {t("network.dns.otherBackups", { names: current.otherBackups.join(", ") })}</>}
                  </p>
                  <Button size="sm" variant="secondary" icon={<RotateCcw className="h-3.5 w-3.5" />} loading={working === "restore"} disabled={locked && working !== "restore"} onClick={() => void restore()}>
                    {t("network.dns.restore")}
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div className="mt-2 text-[12px] text-muted">{t("network.dns.noAdapter")}</div>
          )}
        </div>

        {canChange ? (
          <div className="glass rounded-xl p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-fg">
              <ShieldCheck className="h-4 w-4 text-accent" aria-hidden /> {t("network.dns.safeTitle")}
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-muted">{t("network.dns.safeText")}</p>
          </div>
        ) : (
          results.length > 0 &&
          howToTarget && (
            <motion.div className="glass rounded-xl p-4" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
              <div className="text-sm font-semibold text-fg">{t("network.dns.howTo")}</div>
              {current && <p className="mt-1 text-[12px] text-muted">{t("network.dns.cannotChange")}</p>}
              <pre className="mt-2 font-sans text-[12px] leading-relaxed whitespace-pre-wrap text-muted">{t("network.dns.howToSteps", { primary: howToTarget.primary, secondary: howToTarget.secondary ?? howToTarget.primary })}</pre>
              <Button variant="secondary" size="sm" className="mt-3" icon={<ExternalLink className="h-3.5 w-3.5" />} onClick={() => void api.openUrl("ms-settings:network-status").catch(() => undefined)}>
                {t("network.dns.openSettings")}
              </Button>
            </motion.div>
          )
        )}
      </div>
    </div>
  );
}
