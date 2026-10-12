import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ACHIEVEMENTS, TIER_COLORS } from "@/lib/achievements";
import { useT } from "@/lib/i18n";
import { useUI } from "@/store/ui";
import { useSettings } from "@/store/settings";
import { Icon } from "./ui/icons";
import { Starfield, type StarfieldHandle } from "@shared/ui/Starfield";
import { spring } from "@shared/design/motion";
import { sound } from "@shared/sound/engine";
import { isTauri } from "@shared/lib/env";

/** Abzeichen-Pop-up mit Partikeln und eigenem Sound */
export function AchievementPopup() {
  const t = useT();
  const queue = useUI((s) => s.achievementQueue);
  const shift = useUI((s) => s.shiftAchievement);
  const current = queue[0];
  const def = ACHIEVEMENTS.find((a) => a.id === current);
  const stars = useRef<StarfieldHandle>(null);

  useEffect(() => {
    if (!current) return;
    sound.play("achievement");
    const b = window.setTimeout(() => stars.current?.burst(210, 70, { count: 70, speed: 6, life: 1.4 }), 250);
    const id = window.setTimeout(shift, 4800);
    if (useSettings.getState().settings.notifications && isTauri() && document.hidden) {
      void import("@tauri-apps/plugin-notification")
        .then((n) => n.sendNotification({ title: t("achievements.unlocked"), body: t(`achievements.${current}.name`) }))
        .catch(() => undefined);
    }
    return () => {
      window.clearTimeout(id);
      window.clearTimeout(b);
    };
  }, [current, shift, t]);

  const [c1, c2] = def ? TIER_COLORS[def.tier] : ["#fff", "#999"];

  return (
    <div className="pointer-events-none fixed top-16 left-1/2 -translate-x-1/2" style={{ zIndex: "var(--nv-z-toast)" }}>
      <AnimatePresence mode="wait">
        {def && (
          <motion.div
            key={def.id}
            className="glass-strong pointer-events-auto relative flex w-[420px] items-center gap-4 overflow-hidden rounded-2xl p-4"
            initial={{ opacity: 0, y: -40, scale: 0.85 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -24, scale: 0.92 }}
            transition={spring.bouncy}
            onClick={shift}
          >
            <Starfield ref={stars} className="absolute inset-0" density={0.4} drift={0} parallax={false} still />
            <motion.div
              className="relative grid h-16 w-16 shrink-0 place-items-center rounded-2xl"
              style={{ background: `linear-gradient(135deg, ${c1}, ${c2})`, boxShadow: `0 0 30px -4px ${c1}` }}
              initial={{ rotate: -30, scale: 0 }}
              animate={{ rotate: 0, scale: 1 }}
              transition={{ ...spring.bouncy, delay: 0.15 }}
            >
              <Icon name={def.icon} className="h-8 w-8 text-white drop-shadow" strokeWidth={2} />
              <motion.div className="absolute inset-0 rounded-2xl" style={{ background: "linear-gradient(120deg, transparent 30%, rgb(255 255 255 / 0.6) 50%, transparent 70%)" }} initial={{ x: "-120%" }} animate={{ x: "120%" }} transition={{ duration: 1, delay: 0.5 }} />
            </motion.div>
            <div className="relative min-w-0">
              <div className="text-[11px] font-semibold tracking-[0.18em] text-accent uppercase">{t("achievements.unlocked")}</div>
              <div className="mt-0.5 font-display text-lg font-bold text-fg">{t(`achievements.${def.id}.name`)}</div>
              <div className="text-[13px] text-muted">{t(`achievements.${def.id}.desc`)}</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
