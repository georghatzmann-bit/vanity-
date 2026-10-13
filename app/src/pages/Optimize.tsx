import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { BatteryCharging, Check, Eraser, Info, Loader2, MousePointer2, RotateCcw, Video, Zap } from "lucide-react";
import { api, errorText } from "@/lib/api";
import { useT } from "@/lib/i18n";
import type { PowerPlan, Tweak } from "@/lib/types";
import { useBoost } from "@/store/boost";
import { useSettings } from "@/store/settings";
import { toast } from "@/store/ui";
import { Field, Section } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
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
};

function ImpactPill({ impact }: { impact: Tweak["impact"] }) {
  const t = useT();
  const cls = impact === "high" ? "bg-success/15 text-success" : impact === "medium" ? "bg-accent/15 text-accent" : "bg-surface-3 text-muted";
  return <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", cls)}>{t(`optimize.impact.${impact}`)}</span>;
}

/** Optimieren: Windows-Einstellungen mit Rückgängig, Energieplan, Boost-Profil */
export function Optimize() {
  const t = useT();
  const [tweaks, setTweaks] = useState<Tweak[]>([]);
  const [plans, setPlans] = useState<PowerPlan[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const boost = useBoost((s) => s.state);

  const load = async () => {
    const [tw, pl] = await Promise.all([api.tweaks().catch(() => [] as Tweak[]), api.powerPlans().catch(() => [] as PowerPlan[])]);
    setTweaks(tw);
    setPlans(pl);
  };
  useEffect(() => {
    void load();
  }, []);

  const apply = async (ids: string[], enable: boolean) => {
    setBusy(ids.join(","));
    try {
      const rep = await api.tweaksApply(ids, enable);
      if (rep.failed.length) toast({ kind: "warning", title: t("toast.error"), text: rep.failed.map((f) => f.error).join(" · ") });
      else if (enable) toast({ kind: "success", title: t("optimize.applied", { n: rep.applied.length }) });
      sound.play(enable ? "toggleOn" : "toggleOff");
      await load();
    } catch (e) {
      toast({ kind: "error", title: t("toast.error"), text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const activePlan = plans.find((p) => p.active);
  const recommended = tweaks.filter((x) => x.state === "off").map((x) => x.id);

  return (
    <motion.div className="mx-auto max-w-[1200px] px-8 pt-3 pb-24" variants={staggerContainer(0.05)} initial="initial" animate="enter">
      <motion.div variants={staggerItem} className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold text-fg">{t("optimize.title")}</h1>
          <p className="mt-1 text-sm text-muted">{t("optimize.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" icon={<RotateCcw className="h-4 w-4" />} onClick={async () => {
            await api.tweaksRevertAll().catch((e) => toast({ kind: "error", title: errorText(e) }));
            toast({ kind: "info", title: t("optimize.reverted") });
            await load();
          }}>
            {t("optimize.revertAll")}
          </Button>
          <Button variant="primary" icon={<Check className="h-4 w-4" />} disabled={!recommended.length} onClick={() => void apply(recommended, true)}>
            {t("optimize.applyAll")}
          </Button>
        </div>
      </motion.div>

      <div className="mt-6 grid grid-cols-1 gap-5 xl:grid-cols-[1.4fr_1fr]">
        <motion.div variants={staggerItem} className="flex flex-col gap-3">
          <div className="px-1 text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{t("optimize.tweaks")}</div>
          {tweaks.map((tw, i) => {
            const on = tw.state === "on";
            const unsupported = tw.state === "unsupported";
            return (
              <motion.div key={tw.id} className={cn("glass flex items-center gap-4 rounded-xl p-4 transition", on && "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--nv-accent)_45%,transparent)]")} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }}>
                <span className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-xl", on ? "bg-gradient-accent text-accent-fg shadow-glow" : "bg-surface-2 text-muted")}>{ICONS[tw.id]}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-fg">{t(`optimize.items.${tw.id}.name`)}</span>
                    <ImpactPill impact={tw.impact} />
                    <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[10px] text-muted">{t(`optimize.categories.${tw.category}`)}</span>
                  </div>
                  <div className="mt-0.5 text-[12px] leading-snug text-muted">{t(`optimize.items.${tw.id}.desc`)}</div>
                  <div className="mt-1 text-[11px] text-faint">
                    {t(`optimize.state.${tw.state}`)}
                    {tw.detail ? ` · ${tw.detail}` : ""}
                    {tw.canRevert ? ` · ${t("optimize.canRevert")}` : ""}
                  </div>
                </div>
                {busy?.includes(tw.id) ? <Loader2 className="h-5 w-5 animate-spin text-accent" /> : <Toggle checked={on} disabled={unsupported} onChange={(v) => void apply([tw.id], v)} />}
              </motion.div>
            );
          })}
          {!tweaks.length && <div className="glass rounded-xl p-6 text-center text-sm text-muted">{t("common.loading")}</div>}
        </motion.div>

        <motion.div variants={staggerItem} className="flex flex-col gap-5">
          <Section title={t("optimize.power")} icon={<BatteryCharging className="h-4 w-4" />}>
            <Field label={t("optimize.power")} description={activePlan ? t("optimize.powerActive", { name: activePlan.name }) : undefined} stacked>
              <Select value={activePlan?.guid ?? ""} onChange={async (guid) => {
                await api.powerSet(guid).catch((e) => toast({ kind: "error", title: errorText(e) }));
                await load();
              }} options={plans.map((p) => ({ value: p.guid, label: p.name }))} className="w-full" />
            </Field>
            <Field label={t("optimize.flushDns")} description={t("optimize.flushDnsDesc")}>
              <Button size="sm" variant="secondary" icon={<Eraser className="h-3.5 w-3.5" />} onClick={() => void api.flushDns().then(() => toast({ kind: "success", title: t("optimize.flushed") })).catch((e) => toast({ kind: "error", title: errorText(e) }))}>
                {t("optimize.flushDns")}
              </Button>
            </Field>
          </Section>

          <Section title={t("optimize.boostProfile")} icon={<Zap className="h-4 w-4" />}>
            <div className="pt-3 pb-1 text-[12px] text-muted">{t("optimize.boostProfileDesc")}</div>
            <Field label={t("optimize.boostPower")} description={t("optimize.boostPowerDesc")}>
              <Toggle checked={settings.boostProfile.powerPlan} onChange={(v) => update({ boostProfile: { ...settings.boostProfile, powerPlan: v } })} />
            </Field>
            <Field label={t("optimize.boostPriority")} description={t("optimize.boostPriorityDesc")}>
              <Select value={settings.boostProfile.gamePriority} onChange={(v) => update({ boostProfile: { ...settings.boostProfile, gamePriority: v } })} options={(["normal", "above", "high"] as const).map((p) => ({ value: p, label: t(`optimize.priorities.${p}`) }))} className="w-40" align="right" />
            </Field>
            <Field label={t("optimize.boostFlush")} description={t("optimize.boostFlushDesc")}>
              <Toggle checked={settings.boostProfile.flushDns} onChange={(v) => update({ boostProfile: { ...settings.boostProfile, flushDns: v } })} />
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
