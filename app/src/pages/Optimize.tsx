import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { BatteryCharging, Check, Eraser, Gauge, Info, Loader2, MousePointer2, RotateCcw, Send, Video, Zap } from "lucide-react";
import { api, errorText } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { AUTO_TWEAKS, backendText, isDeclined, restoreDeclined } from "@/lib/netauto";
import type { PowerPlan, Tweak } from "@/lib/types";
import { useBoost } from "@/store/boost";
import { restoreProblems, useNetAuto, useWindowsLocked, withWindowsLock } from "@/store/netauto";
import { useSettings } from "@/store/settings";
import { toast, useUI } from "@/store/ui";
import { NetAutoCard } from "@/components/NetAutoCard";
import { Field, Section } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { TweakBadges } from "@/components/ui/TweakBadges";
import { Button } from "@shared/ui/Button";
import { Toggle } from "@shared/ui/Toggle";
import { cn } from "@shared/lib/cn";
import { staggerContainer, staggerItem } from "@shared/design/motion";
import { sound } from "@shared/sound/engine";

const ICONS: Record<string, React.ReactNode> = {
  powerPlan: <BatteryCharging className="h-5 w-5" />,
  gameMode: <Zap className="h-5 w-5" />,
  gameDvr: <Video className="h-5 w-5" />,
  mouseAccel: <MousePointer2 className="h-5 w-5" />,
  nagle: <Send className="h-5 w-5" />,
  netThrottle: <Gauge className="h-5 w-5" />,
};

/** Reihenfolge der Gruppen in der Liste */
const GROUPS: Tweak["category"][] = ["windows", "power", "input", "network"];

function ImpactPill({ impact }: { impact: Tweak["impact"] }) {
  const t = useT();
  const cls = impact === "high" ? "bg-success/15 text-success-fg" : impact === "medium" ? "bg-accent/15 text-accent-text" : "bg-surface-3 text-muted";
  return <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", cls)}>{t(`optimize.impact.${impact}`)}</span>;
}

/** Optimieren: Netzwerk-Automatik, Windows-Einstellungen mit Rückgängig, Energieplan, Boost-Profil */
export function Optimize({ section }: { section?: string }) {
  const t = useT();
  const [tweaks, setTweaks] = useState<Tweak[]>([]);
  const [plans, setPlans] = useState<PowerPlan[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reverting, setReverting] = useState(false);
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const boost = useBoost((s) => s.state);
  const autoVersion = useNetAuto((s) => s.version);
  // Gemeinsame Sperre: Solange irgendwo eine Änderung an Windows läuft, bleibt hier alles gesperrt, was Windows ändert
  const windowsBusy = useNetAuto((s) => s.windowsBusy);
  const windowsLocked = useWindowsLocked();

  const load = async () => {
    const [tw, pl] = await Promise.all([api.tweaks().catch(() => [] as Tweak[]), api.powerPlans().catch(() => [] as PowerPlan[])]);
    setTweaks(tw);
    setPlans(pl);
    setLoaded(true);
  };
  useEffect(() => {
    void load();
  }, [autoVersion]);

  // Befehlspalette: „Netzwerk automatisch optimieren“ öffnet diese Seite mit section "auto"
  useEffect(() => {
    if (section !== "auto") return;
    useUI.setState({ route: { page: "optimize" } });
    void useNetAuto.getState().start();
  }, [section]);

  const apply = (ids: string[], enable: boolean) =>
    withWindowsLock(async () => {
      setBusy(ids.join(","));
      try {
        const rep = await api.tweaksApply(ids, enable);
        const declined = rep.failed.filter((f) => isDeclined(f.error));
        const other = rep.failed.filter((f) => !isDeclined(f.error));
        if (other.length) toast({ kind: "warning", title: t("toast.error"), text: other.map((f) => backendText(f.error, t)).join(" · ") });
        else if (declined.length) toast({ kind: "info", title: t("optimize.declined"), text: t("optimize.declinedText") });
        else if (enable) toast({ kind: "success", title: t("optimize.applied", { n: rep.applied.length }) });
        if (!rep.failed.length) sound.play(enable ? "toggleOn" : "toggleOff");
      } catch (e) {
        toast({ kind: "error", title: t("toast.error"), text: errorText(e) });
      } finally {
        setBusy(null);
        await load();
        // nagle/netThrottle gehören auch zur Automatik-Karte: Plan oder Ergebnis dort sind jetzt veraltet
        if (ids.some((id) => (AUTO_TWEAKS as readonly string[]).includes(id))) await useNetAuto.getState().externalChange();
      }
    });

  /**
   * Alles zurück, mit höchstens einer Windows-Abfrage: erst DNS, nagle und netThrottle (net_auto_restore),
   * danach nur die Optimierungen ohne Adminrechte, die eine Sicherung haben (opt_apply mit enable = false).
   */
  const revertAll = () =>
    withWindowsLock(async () => {
      setReverting(true);
      try {
        const problems: string[] = [];
        let done = false;
        let restart = false;
        // Immer aufrufen: Das Backend kennt auch Sicherungen anderer Verbindungen und fragt Windows nur,
        // wenn es wirklich etwas zurückzustellen gibt (sonst keine Abfrage)
        try {
          const rep = await api.autoRestore();
          if (restoreDeclined(rep)) {
            // Abgelehnt: dann auch sonst nichts anfassen – „Nein“ heißt „nichts ändern“
            toast({ kind: "info", title: t("optimize.auto.restoreDeclined"), text: t("optimize.auto.restoreDeclinedText") });
            return;
          }
          problems.push(...restoreProblems(rep));
          done = rep.dnsChanged || rep.applied.length > 0;
          restart = rep.restart;
        } catch (e) {
          // Ehrlich melden, aber die Optimierungen ohne Adminrechte trotzdem zurückstellen
          problems.push(backendText(errorText(e), t));
        }
        // Nur Einträge mit Sicherung: „aus“ ohne Sicherung würde Windows-Standards setzen statt der alten Werte
        const ids = (await api.tweaks()).filter((tw) => tw.canRevert && !tw.admin).map((tw) => tw.id);
        if (ids.length) {
          const rep = await api.tweaksApply(ids, false);
          problems.push(...rep.failed.map((f) => backendText(f.error, t)));
          done = done || rep.applied.length > 0;
        }
        if (problems.length) toast({ kind: "warning", title: t("optimize.revertPartial"), text: [...new Set(problems)].join(" · ") });
        else if (!done) toast({ kind: "info", title: t("optimize.auto.nothingToRestore") });
        else toast({ kind: "success", title: t("optimize.reverted"), text: restart ? t("optimize.revertedRestart") : undefined });
      } catch (e) {
        toast({ kind: "error", title: t("toast.error"), text: errorText(e) });
      } finally {
        setReverting(false);
        await load();
        // Die Automatik-Karte darf danach kein altes Ergebnis mehr zeigen
        await useNetAuto.getState().externalChange();
      }
    });

  const setPower = (guid: string) =>
    withWindowsLock(async () => {
      await api.powerSet(guid).catch((e) => toast({ kind: "error", title: errorText(e) }));
      await load();
    });

  const activePlan = plans.find((p) => p.active);
  // „Alle empfohlenen“ nimmt nur Optimierungen ohne Windows-Abfrage
  const recommended = tweaks.filter((x) => x.state === "off" && !x.admin).map((x) => x.id);

  return (
    <motion.div className="mx-auto max-w-[1200px] px-8 pt-3 pb-24" variants={staggerContainer(0.05)} initial="initial" animate="enter">
      <motion.div variants={staggerItem} className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold text-fg">{t("optimize.title")}</h1>
          <p className="mt-1 text-sm text-muted">{t("optimize.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" icon={<RotateCcw className="h-4 w-4" />} loading={reverting} disabled={windowsLocked && !reverting} onClick={() => void revertAll()}>
            {t("optimize.revertAll")}
          </Button>
          <Button variant="secondary" icon={<Check className="h-4 w-4" />} disabled={!recommended.length || !!busy || windowsBusy} onClick={() => void apply(recommended, true)}>
            {t("optimize.applyAll")}
          </Button>
        </div>
      </motion.div>

      <motion.div variants={staggerItem} className="mt-6">
        <NetAutoCard />
      </motion.div>

      <div className="mt-6 grid grid-cols-1 gap-5 xl:grid-cols-[1.4fr_1fr]">
        <motion.div variants={staggerItem} className="flex flex-col gap-5">
          {GROUPS.map((cat) => {
            const list = tweaks.filter((tw) => tw.category === cat);
            if (!list.length) return null;
            return (
              <section key={cat} aria-labelledby={`opt-group-${cat}`} className="flex flex-col gap-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-1">
                  <h2 id={`opt-group-${cat}`} className="font-sans text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">
                    {t(`optimize.categories.${cat}`)}
                  </h2>
                  {cat === "network" && <span className="text-[11px] text-muted">{t("optimize.networkHint")}</span>}
                </div>
                {list.map((tw, i) => {
                  const on = tw.state === "on";
                  const unsupported = tw.state === "unsupported" || tw.state === "unknown";
                  const working = busy?.split(",").includes(tw.id);
                  return (
                    <motion.div key={tw.id} className={cn("glass flex items-center gap-4 rounded-xl p-4 transition-shadow duration-200", on && "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--nv-accent)_45%,transparent)]")} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }}>
                      <span className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-xl transition-colors duration-200", on ? "bg-gradient-accent text-accent-fg shadow-glow" : "bg-surface-2 text-muted")}>{ICONS[tw.id]}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-sm font-semibold text-fg">{t(`optimize.items.${tw.id}.name`)}</span>
                          <ImpactPill impact={tw.impact} />
                          <TweakBadges admin={tw.admin} restart={tw.restart} />
                        </div>
                        <div className="mt-0.5 text-[12px] leading-snug text-muted">{t(`optimize.items.${tw.id}.desc`)}</div>
                        <div className="mt-1 text-[11px] text-muted">
                          {working && tw.admin ? t("optimize.waitingUac") : t(`optimize.state.${tw.state}`)}
                          {tw.detail ? ` · ${tw.detail}` : ""}
                          {tw.canRevert ? ` · ${t("optimize.canRevert")}` : ""}
                        </div>
                      </div>
                      {working ? <Loader2 className="h-5 w-5 animate-spin text-accent" aria-label={t("common.loading")} /> : <Toggle checked={on} disabled={unsupported || !!busy || windowsBusy} label={t(`optimize.items.${tw.id}.name`)} onChange={(v) => void apply([tw.id], v)} />}
                    </motion.div>
                  );
                })}
              </section>
            );
          })}
          {!loaded && <div className="glass rounded-xl p-6 text-center text-sm text-muted">{t("common.loading")}</div>}
          {loaded && !tweaks.length && (
            <div className="glass flex items-center gap-3 rounded-xl p-5 text-sm text-muted">
              <Info className="h-5 w-5 shrink-0 text-accent" /> {t("optimize.noTweaks")}
            </div>
          )}
        </motion.div>

        <motion.div variants={staggerItem} className="flex flex-col gap-5">
          <Section title={t("optimize.power")} icon={<BatteryCharging className="h-4 w-4" />}>
            <Field label={t("optimize.power")} description={activePlan ? t("optimize.powerActive", { name: activePlan.name }) : undefined} stacked>
              <Select value={activePlan?.guid ?? ""} disabled={windowsBusy} onChange={(guid) => void setPower(guid)} options={plans.map((p) => ({ value: p.guid, label: p.name }))} className="w-full" />
            </Field>
            <Field label={t("optimize.flushDns")} description={t("optimize.flushDnsDesc")}>
              <Button size="sm" variant="secondary" icon={<Eraser className="h-3.5 w-3.5" />} disabled={windowsBusy} onClick={() => void api.flushDns().then(() => toast({ kind: "success", title: t("optimize.flushed") })).catch((e) => toast({ kind: "error", title: errorText(e) }))}>
                {t("optimize.flushNow")}
              </Button>
            </Field>
          </Section>

          <Section title={t("optimize.boostProfile")} icon={<Zap className="h-4 w-4" />}>
            <div className="pt-3 pb-1 text-[12px] text-muted">{t("optimize.boostProfileDesc")}</div>
            <Field label={t("optimize.boostPower")} description={t("optimize.boostPowerDesc")}>
              <Toggle checked={settings.boostProfile.powerPlan} label={t("optimize.boostPower")} onChange={(v) => update({ boostProfile: { ...settings.boostProfile, powerPlan: v } })} />
            </Field>
            <Field label={t("optimize.boostPriority")} description={t("optimize.boostPriorityDesc")}>
              <Select value={settings.boostProfile.gamePriority} onChange={(v) => update({ boostProfile: { ...settings.boostProfile, gamePriority: v } })} options={(["normal", "above", "high"] as const).map((p) => ({ value: p, label: t(`optimize.priorities.${p}`) }))} className="w-40" align="right" />
            </Field>
            <Field label={t("optimize.boostFlush")} description={t("optimize.boostFlushDesc")}>
              <Toggle checked={settings.boostProfile.flushDns} label={t("optimize.boostFlush")} onChange={(v) => update({ boostProfile: { ...settings.boostProfile, flushDns: v } })} />
            </Field>
            {boost.active && (
              <div className="py-3">
                <div className="mb-1.5 text-[11px] font-semibold tracking-[0.12em] text-accent uppercase">{t("cockpit.boostActive")}</div>
                <ul className="space-y-1 text-[12px] text-muted">
                  {boost.actions.map((a) => (
                    <li key={a.id} className="flex items-start gap-2">
                      <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", a.ok ? "bg-success" : "bg-warning")} />
                      {a.detail}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Section>

          <div className="glass rounded-xl p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-fg">
              <Info className="h-4 w-4 text-accent" /> {t("optimize.honest")}
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-muted">{t("optimize.honestText")}</p>
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}
