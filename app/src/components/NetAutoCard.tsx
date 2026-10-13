import { useEffect, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Check, CircleSlash, ExternalLink, Gauge, Globe, Info, Loader2, RotateCcw, RotateCw, Send, ShieldCheck, Sparkles } from "lucide-react";
import { useT } from "@/lib/i18n";
import { AUTO_TWEAKS, isDeclined, isManualProvider, providerName, shortDnsName } from "@/lib/netauto";
import type { TweakId } from "@/lib/types";
import { dnsChangePossible, dnsLabel, pulsarChanges, useNetAuto, type NetAutoChoice } from "@/store/netauto";
import { useUI } from "@/store/ui";
import { TweakBadges } from "@/components/ui/TweakBadges";
import { Button } from "@shared/ui/Button";
import { ProgressBar } from "@shared/ui/ProgressBar";
import { Toggle } from "@shared/ui/Toggle";
import { cn } from "@shared/lib/cn";

const TWEAK_ICONS: Record<string, ReactNode> = {
  nagle: <Send className="h-[18px] w-[18px]" />,
  netThrottle: <Gauge className="h-[18px] w-[18px]" />,
};

type Status = "ok" | "warn" | "skip" | "keep";

/** Status mit Symbol und Wort – nie nur Farbe */
function StatusPill({ status, children }: { status: Status; children: ReactNode }) {
  const cls = { ok: "bg-success/15 text-success", warn: "bg-warning/15 text-warning", skip: "bg-surface-3 text-muted", keep: "bg-surface-3 text-fg-soft" }[status];
  const icon = status === "warn" ? <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> : status === "skip" ? <CircleSlash className="h-3.5 w-3.5" aria-hidden /> : <Check className="h-3.5 w-3.5" aria-hidden />;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap", cls)}>
      {icon}
      {children}
    </span>
  );
}

/** Eine Zeile im Plan bzw. Ergebnis: Symbol, Titel, graue Erklärzeile, rechts Schalter oder Status */
function Row({ icon, title, desc, extra, badges, control, dim }: { icon: ReactNode; title: ReactNode; desc: ReactNode; extra?: ReactNode; badges?: ReactNode; control?: ReactNode; dim?: boolean }) {
  return (
    <div className={cn("flex items-center gap-4 px-4 py-3.5 transition-opacity duration-150", dim && "opacity-60")}>
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-surface-2 text-accent">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold text-fg">{title}</span>
          {badges}
        </div>
        <div className="mt-0.5 text-[12px] leading-snug text-muted">{desc}</div>
        {extra && <div className="mt-1 text-[12px] leading-snug text-fg-soft">{extra}</div>}
      </div>
      {control && <div className="shrink-0">{control}</div>}
    </div>
  );
}

function Hint({ icon, children, tone = "neutral" }: { icon: ReactNode; children: ReactNode; tone?: "neutral" | "accent" }) {
  return (
    <div className={cn("flex gap-3 rounded-xl border p-3 text-[12px] leading-relaxed", tone === "accent" ? "border-accent/30 bg-accent/10 text-fg-soft" : "border-line bg-surface text-muted")}>
      <span className={cn("mt-px shrink-0", tone === "accent" ? "text-accent" : "text-muted")} aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const fade = { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -4 }, transition: { duration: 0.18 } };

/**
 * Karte „Netzwerk automatisch optimieren“ (ganz oben auf der Optimieren-Seite):
 * DNS-Dienste vergleichen → Vorschlag mit Schaltern → mit einer Windows-Abfrage einstellen → Ergebnis, alles zurückstellbar.
 */
export function NetAutoCard() {
  const t = useT();
  const s = useNetAuto();

  useEffect(() => {
    if (useNetAuto.getState().phase === "idle") void useNetAuto.getState().refresh();
  }, []);

  const changes = pulsarChanges(s.dns, s.tweaks);
  const hasChanges = changes.dns || changes.tweaks.length > 0;
  const tweakOf = (id: TweakId) => s.tweaks.find((tw) => tw.id === id);
  const offTweaks = AUTO_TWEAKS.filter((id) => tweakOf(id)?.state === "off");
  const onTweaks = AUTO_TWEAKS.filter((id) => tweakOf(id)?.state === "on");
  const naTweaks = AUTO_TWEAKS.filter((id) => {
    const st = tweakOf(id)?.state;
    return st === "unknown" || st === "unsupported";
  });
  const canDns = dnsChangePossible(s.pick, s.dns);
  const selected = (canDns && s.choice.dns) || offTweaks.some((id) => s.choice[id as keyof NetAutoChoice]);
  const nothingToDo = !canDns && offTweaks.length === 0;
  // „Alles gut“ nur, wenn wirklich alles geprüft und optimal ist – nicht, wenn etwas hier gar nicht geht
  const allGood = nothingToDo && s.pick?.reason === "alreadyFast" && !!s.dns?.canChange && onTweaks.length === AUTO_TWEAKS.length;
  const busy = s.phase === "applying";
  const tweakName = (id: string) => t(`optimize.items.${id}.name`);

  // ---- DNS-Zeile im Plan --------------------------------------------------------------------
  const dnsPlan = (() => {
    const { pick, dns } = s;
    if (!dns) return { change: false, desc: t("optimize.auto.dnsNoAdapter"), extra: null as ReactNode };
    if (!dns.canChange) {
      return {
        change: false,
        desc: t("optimize.auto.dnsCannot"),
        extra: (
          <button type="button" className="inline-flex items-center gap-1 font-medium text-accent hover:underline" onClick={() => useUI.getState().navigate({ page: "network", section: "dns" })}>
            {t("optimize.auto.dnsHowTo")} <ExternalLink className="h-3 w-3" aria-hidden />
          </button>
        ),
      };
    }
    if (!pick || pick.reason === "noData") return { change: false, desc: t("optimize.auto.dnsNoData"), extra: null };
    if (canDns && pick.best) {
      const from = pick.current ? shortDnsName(pick.current) : dnsLabel(dns);
      const desc =
        pick.bestScore !== null && pick.currentScore !== null
          ? t("optimize.auto.dnsChangeDesc", { from, to: pick.best.name, ms: Math.round(pick.bestScore), old: Math.round(pick.currentScore) })
          : t("optimize.auto.dnsChangeDescNoOld", { from, to: pick.best.name, ms: Math.round(pick.bestScore ?? 0) });
      return { change: true, desc, extra: isManualProvider(dns.provider) ? t("optimize.auto.dnsManual", { name: providerName(dns.provider) }) : null };
    }
    const name = pick.current ? shortDnsName(pick.current) : dnsLabel(dns);
    const desc = pick.currentScore !== null ? `${t("optimize.auto.dnsKeepDesc")} · ${name}: ${Math.round(pick.currentScore)} ms` : t("optimize.auto.dnsKeepDesc");
    return { change: false, desc, extra: null };
  })();

  // ---- Ergebniszeilen -----------------------------------------------------------------------
  const resultRows: { key: string; status: Status; label: string; title: string; desc: string; icon: ReactNode }[] = [];
  if (s.report && s.requested) {
    const rep = s.report;
    if (s.requested.provider) {
      const name = providerName(s.requested.provider);
      if (rep.declined && (!rep.dnsChanged || isDeclined(rep.dnsError))) resultRows.push({ key: "dns", status: "skip", label: t("optimize.auto.rowDeclined"), title: t("optimize.auto.dnsTitle"), desc: t("optimize.auto.rowDeclinedDesc"), icon: <Globe className="h-[18px] w-[18px]" /> });
      else if (rep.dnsError) resultRows.push({ key: "dns", status: "warn", label: t("optimize.auto.rowFailed"), title: t("optimize.auto.dnsTitle"), desc: rep.dnsError, icon: <Globe className="h-[18px] w-[18px]" /> });
      else resultRows.push({ key: "dns", status: "ok", label: t("optimize.auto.rowDone"), title: t("optimize.auto.dnsDone", { name }), desc: t("optimize.auto.dnsDoneDesc", { servers: rep.dns?.servers.join(", ") || "–" }), icon: <Globe className="h-[18px] w-[18px]" /> });
    }
    for (const id of s.requested.tweaks) {
      const failed = rep.failed.find((f) => f.id === id);
      const icon = TWEAK_ICONS[id];
      if (rep.applied.includes(id)) resultRows.push({ key: id, status: "ok", label: t("optimize.auto.rowDone"), title: tweakName(id), desc: t("optimize.auto.tweakDone"), icon });
      else if (rep.declined || isDeclined(failed?.error)) resultRows.push({ key: id, status: "skip", label: t("optimize.auto.rowDeclined"), title: tweakName(id), desc: t("optimize.auto.rowDeclinedDesc"), icon });
      else resultRows.push({ key: id, status: "warn", label: t("optimize.auto.rowFailed"), title: tweakName(id), desc: failed?.error ?? t("optimize.auto.rowUnknown"), icon });
    }
  }
  const okCount = resultRows.filter((r) => r.status === "ok").length;
  const declined = !!s.report?.declined || (resultRows.length > 0 && resultRows.every((r) => r.status === "skip"));
  const resultHead = declined
    ? { icon: <CircleSlash className="h-5 w-5" />, cls: "bg-surface-3 text-muted", text: t("optimize.auto.resultDeclined") }
    : okCount === resultRows.length
      ? { icon: <Check className="h-5 w-5" />, cls: "bg-success/15 text-success", text: t("optimize.auto.resultDone") }
      : okCount > 0
        ? { icon: <AlertTriangle className="h-5 w-5" />, cls: "bg-warning/15 text-warning", text: t("optimize.auto.resultPartial") }
        : { icon: <AlertTriangle className="h-5 w-5" />, cls: "bg-warning/15 text-warning", text: t("optimize.auto.resultFailed") };

  return (
    <section aria-labelledby="netauto-title" className="glass relative overflow-hidden rounded-2xl">
      {/* Akzent: feine Leuchtkante oben und weicher Schein in der Ecke */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-accent opacity-70" />
      <div aria-hidden className="pointer-events-none absolute -top-28 -right-20 h-72 w-72 rounded-full blur-3xl" style={{ background: "var(--nv-glow-a)" }} />

      <div className="relative p-6">
        {/* Kopf */}
        <div className="flex flex-wrap items-start gap-4">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-gradient-accent text-accent-fg shadow-glow">
            <Sparkles className="h-6 w-6" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="netauto-title" className="font-display text-xl font-bold text-fg">
              {t("optimize.auto.title")}
            </h2>
            <p className="mt-1 max-w-[760px] text-[13px] leading-relaxed text-muted">{t("optimize.auto.desc")}</p>
          </div>
          {s.phase === "idle" && hasChanges && (
            <StatusPill status="ok">{t("optimize.auto.byPulsar")}</StatusPill>
          )}
        </div>

        <AnimatePresence mode="wait" initial={false}>
          {/* ---- Ruhezustand: noch nichts geändert ---- */}
          {s.phase === "idle" && !hasChanges && (
            <motion.div key="idle" {...fade} className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[1fr_auto] xl:items-end">
              <ul className="grid grid-cols-1 gap-2 lg:grid-cols-3">
                {[
                  { icon: <Globe className="h-4 w-4" />, title: t("optimize.auto.checkDns"), desc: t("optimize.auto.checkDnsDesc") },
                  { icon: <Send className="h-4 w-4" />, title: tweakName("nagle"), desc: t("optimize.auto.checkNagleDesc") },
                  { icon: <Gauge className="h-4 w-4" />, title: tweakName("netThrottle"), desc: t("optimize.auto.checkThrottleDesc") },
                ].map((c) => (
                  <li key={c.title} className="flex min-w-0 gap-3 rounded-xl border border-line bg-surface px-3.5 py-3">
                    <span className="mt-0.5 shrink-0 text-accent" aria-hidden>
                      {c.icon}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium text-fg">{c.title}</span>
                      <span className="block text-[12px] leading-snug text-muted">{c.desc}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <div className="flex flex-col items-start gap-2 xl:items-end">
                <Button variant="primary" size="lg" icon={<Sparkles className="h-4 w-4" />} onClick={() => void s.start()}>
                  {t("optimize.auto.start")}
                </Button>
                <span className="text-[12px] text-muted">{t("optimize.auto.startHint")}</span>
              </div>
            </motion.div>
          )}

          {/* ---- Ruhezustand: Pulsar hat schon etwas geändert ---- */}
          {s.phase === "idle" && hasChanges && (
            <motion.div key="changed" {...fade} className="mt-5">
              <div className="divide-y divide-line rounded-xl border border-line bg-surface">
                {changes.dns && s.dns && (
                  <Row
                    icon={<Globe className="h-[18px] w-[18px]" />}
                    title={t("optimize.auto.changedDns", { name: dnsLabel(s.dns) })}
                    desc={[...s.dns.servers, ...(s.dns.ipv6Servers ?? [])].join(", ") || "–"}
                    control={<StatusPill status="ok">{t("optimize.auto.active")}</StatusPill>}
                  />
                )}
                {changes.tweaks.map((tw) => (
                  <Row key={tw.id} icon={TWEAK_ICONS[tw.id]} title={tweakName(tw.id)} desc={t(`optimize.items.${tw.id}.desc`)} badges={<TweakBadges restart={tw.restart} />} control={<StatusPill status="ok">{t("optimize.auto.active")}</StatusPill>} />
                ))}
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <p className="max-w-[620px] text-[12px] leading-relaxed text-muted">{t("optimize.auto.changedText")}</p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" icon={<RotateCcw className="h-4 w-4" />} loading={s.restoring} onClick={() => void s.restore()}>
                    {t("optimize.auto.restore")}
                  </Button>
                  <Button variant="primary" icon={<Sparkles className="h-4 w-4" />} disabled={s.restoring} onClick={() => void s.start()}>
                    {t("optimize.auto.recheck")}
                  </Button>
                </div>
              </div>
            </motion.div>
          )}

          {/* ---- DNS-Dienste vergleichen ---- */}
          {s.phase === "measuring" && (
            <motion.div key="measuring" {...fade} className="mt-5 rounded-xl border border-line bg-surface p-4" role="status" aria-live="polite">
              <div className="flex items-center justify-between gap-3 text-[13px]">
                <span className="flex items-center gap-2 font-medium text-fg">
                  <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden />
                  {t("optimize.auto.measuring")}
                </span>
                {s.progress && <span className="text-muted tabular">{t("optimize.auto.measuringProgress", { done: s.progress.done, total: s.progress.total })}</span>}
              </div>
              <ProgressBar value={s.progress ? s.progress.done / Math.max(1, s.progress.total) : 0} className="mt-3" />
              <p className="mt-3 text-[12px] leading-relaxed text-muted">{t("optimize.auto.measuringText")}</p>
            </motion.div>
          )}

          {/* ---- Plan (und Warten auf Windows) ---- */}
          {(s.phase === "plan" || s.phase === "applying") && (
            <motion.div key="plan" {...fade} className="mt-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{t("optimize.auto.planTitle")}</div>
                {!nothingToDo && <div className="text-[12px] text-muted">{t("optimize.auto.planText")}</div>}
              </div>
              <div className="mt-2 divide-y divide-line rounded-xl border border-line bg-surface">
                <Row
                  icon={<Globe className="h-[18px] w-[18px]" />}
                  title={dnsPlan.change ? t("optimize.auto.dnsChange") : t("optimize.auto.dnsTitle")}
                  desc={dnsPlan.desc}
                  extra={dnsPlan.extra}
                  badges={dnsPlan.change ? <TweakBadges admin /> : undefined}
                  dim={dnsPlan.change && !s.choice.dns}
                  control={dnsPlan.change ? <Toggle checked={s.choice.dns} disabled={busy} label={t("optimize.auto.dnsChange")} onChange={(v) => s.setChoice("dns", v)} /> : <StatusPill status="keep">{t("optimize.auto.keep")}</StatusPill>}
                />
                {offTweaks.map((id) => {
                  const tw = tweakOf(id);
                  const on = s.choice[id as keyof NetAutoChoice];
                  return (
                    <Row
                      key={id}
                      icon={TWEAK_ICONS[id]}
                      title={tweakName(id)}
                      desc={t(`optimize.items.${id}.desc`)}
                      badges={<TweakBadges admin={tw?.admin} restart={tw?.restart} />}
                      dim={!on}
                      control={<Toggle checked={on} disabled={busy} label={tweakName(id)} onChange={(v) => s.setChoice(id as keyof NetAutoChoice, v)} />}
                    />
                  );
                })}
              </div>
              {(onTweaks.length > 0 || naTweaks.length > 0) && (
                <div className="mt-2 flex flex-col gap-0.5 px-1 text-[12px] text-muted">
                  {onTweaks.length > 0 && (
                    <span className="flex items-center gap-1.5">
                      <Check className="h-3.5 w-3.5 text-success" aria-hidden /> {t("optimize.auto.alreadyOn", { list: onTweaks.map(tweakName).join(", ") })}
                    </span>
                  )}
                  {naTweaks.length > 0 && <span>{t("optimize.auto.notAvailable", { list: naTweaks.map(tweakName).join(", ") })}</span>}
                </div>
              )}

              {nothingToDo ? (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4">
                  <div className="flex items-center gap-3">
                    <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-full", allGood ? "bg-success/15 text-success" : "bg-surface-3 text-muted")}>
                      {allGood ? <Check className="h-5 w-5" aria-hidden /> : <Info className="h-5 w-5" aria-hidden />}
                    </span>
                    <div>
                      <div className="text-sm font-semibold text-fg">{allGood ? t("optimize.auto.nothingToDo") : t("optimize.auto.nothingPossible")}</div>
                      <div className="text-[12px] text-muted">{allGood ? t("optimize.auto.nothingToDoText") : t("optimize.auto.nothingPossibleText")}</div>
                    </div>
                  </div>
                  <Button variant="secondary" onClick={() => s.reset()}>
                    {t("optimize.auto.close")}
                  </Button>
                </div>
              ) : (
                <>
                  <div className="mt-4 grid grid-cols-1 gap-2 xl:grid-cols-2 xl:items-start">
                    {selected && (
                      <Hint icon={<ShieldCheck className="h-4 w-4" />} tone="accent">
                        <span className="font-semibold text-fg">{busy ? t("optimize.auto.waitingTitle") : t("optimize.auto.uacTitle")}</span> {busy ? t("optimize.auto.waitingText") : t("optimize.auto.uacText")}
                      </Hint>
                    )}
                    <Hint icon={<Info className="h-4 w-4" />}>
                      <span className="font-semibold text-fg-soft">{t("optimize.honest")}:</span> {t("optimize.auto.honestText")}
                    </Hint>
                  </div>
                  <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                    <Button variant="ghost" disabled={busy} onClick={() => s.reset()}>
                      {t("common.cancel")}
                    </Button>
                    <Button variant="primary" size="lg" icon={<Check className="h-4 w-4" />} loading={busy} disabled={!selected} onClick={() => void s.apply()}>
                      {busy ? t("optimize.auto.applying") : selected ? t("optimize.auto.apply") : t("optimize.auto.noneSelected")}
                    </Button>
                  </div>
                </>
              )}
            </motion.div>
          )}

          {/* ---- Ergebnis ---- */}
          {s.phase === "result" && s.report && (
            <motion.div key="result" {...fade} className="mt-5" role="status" aria-live="polite">
              <div className="flex items-center gap-3">
                <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-full", resultHead.cls)} aria-hidden>
                  {resultHead.icon}
                </span>
                <div className="font-display text-lg font-bold text-fg">{resultHead.text}</div>
              </div>
              <div className="mt-3 divide-y divide-line rounded-xl border border-line bg-surface">
                {resultRows.map((r) => (
                  <Row key={r.key} icon={r.icon} title={r.title} desc={r.desc} control={<StatusPill status={r.status}>{r.label}</StatusPill>} />
                ))}
              </div>
              <div className="mt-4 grid grid-cols-1 gap-2 xl:grid-cols-2 xl:items-start">
                {declined && (
                  <Hint icon={<Info className="h-4 w-4" />} tone="accent">
                    {t("optimize.auto.declinedText")}
                  </Hint>
                )}
                {s.report.restart && (
                  <Hint icon={<RotateCw className="h-4 w-4" />} tone="accent">
                    <span className="font-semibold text-fg">{t("optimize.auto.restartTitle")}</span> {t("optimize.auto.restartText")}
                  </Hint>
                )}
                {okCount > 0 && s.report.dnsChanged && (
                  <Hint icon={<Info className="h-4 w-4" />}>{t("optimize.auto.dnsAfter")}</Hint>
                )}
              </div>
              <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                <Button variant="ghost" disabled={s.restoring} onClick={() => s.reset()}>
                  {t("optimize.auto.close")}
                </Button>
                {hasChanges && (
                  <Button variant="secondary" icon={<RotateCcw className="h-4 w-4" />} loading={s.restoring} onClick={() => void s.restore()}>
                    {t("optimize.auto.restoreAll")}
                  </Button>
                )}
                {declined && (
                  <Button variant="primary" icon={<ShieldCheck className="h-4 w-4" />} disabled={s.restoring} onClick={() => void s.apply()}>
                    {t("optimize.auto.retry")}
                  </Button>
                )}
              </div>
            </motion.div>
          )}

          {/* ---- Fehler ---- */}
          {s.phase === "error" && (
            <motion.div key="error" {...fade} className="mt-5" role="alert">
              <div className="flex gap-3 rounded-xl border border-danger/30 bg-danger/10 p-4">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-hidden />
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-fg">{s.errorStep === "apply" ? t("optimize.auto.errorApply") : t("optimize.auto.errorMeasure")}</div>
                  <div className="mt-0.5 text-[12px] leading-relaxed text-fg-soft">{s.error}</div>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                <Button variant="ghost" onClick={() => s.reset()}>
                  {t("optimize.auto.close")}
                </Button>
                <Button variant="primary" icon={<RotateCw className="h-4 w-4" />} onClick={() => void s.start()}>
                  {t("optimize.auto.retry")}
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}
