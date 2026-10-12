import { useMemo } from "react";
import { motion } from "motion/react";
import { Lock } from "lucide-react";
import { ACHIEVEMENTS, TIER_COLORS, type AchievementDef } from "@/lib/achievements";
import { formatDate } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { useLibrary } from "@/store/library";
import { Icon } from "@/components/ui/icons";
import { Ring } from "@/components/ui/Ring";
import { cn } from "@shared/lib/cn";
import { staggerContainer, staggerItem } from "@shared/design/motion";
import { sound } from "@shared/sound/engine";

function Badge({ def, unlockedAt, progress }: { def: AchievementDef; unlockedAt?: number; progress: [number, number] }) {
  const t = useT();
  const [c1, c2] = TIER_COLORS[def.tier];
  const done = !!unlockedAt;
  const ratio = Math.min(1, progress[0] / Math.max(1, progress[1]));
  return (
    <motion.div variants={staggerItem} whileHover={{ y: -4 }} onMouseEnter={() => sound.play("hover")} className={cn("glass group relative flex items-center gap-4 overflow-hidden rounded-xl p-4", !done && "opacity-80")}>
      {done && <div className="absolute -top-12 -left-12 h-32 w-32 rounded-full opacity-30 blur-2xl" style={{ background: c1 }} />}
      <div className="relative">
        <motion.div
          className="relative grid h-16 w-16 place-items-center rounded-2xl"
          style={done ? { background: `linear-gradient(135deg, ${c1}, ${c2})`, boxShadow: `0 0 24px -6px ${c1}` } : { background: "var(--nv-surface-2)" }}
          whileHover={done ? { rotate: [0, -8, 8, 0], scale: 1.08 } : undefined}
          transition={{ duration: 0.5 }}
        >
          {done ? <Icon name={def.icon} className="h-7 w-7 text-white drop-shadow" strokeWidth={2} /> : <Lock className="h-6 w-6 text-faint" />}
          {done && <div className="absolute inset-0 overflow-hidden rounded-2xl"><div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/50 to-transparent transition-transform duration-700 group-hover:translate-x-full" /></div>}
        </motion.div>
      </div>
      <div className="relative min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-semibold text-fg">{t(`achievements.${def.id}.name`)}</span>
          <span className="rounded-full px-1.5 py-px text-[9px] font-bold tracking-wider uppercase" style={{ background: `color-mix(in oklab, ${c1} 22%, transparent)`, color: c1 }}>
            {def.tier}
          </span>
        </div>
        <div className="mt-0.5 text-[12px] leading-snug text-muted">{t(`achievements.${def.id}.desc`)}</div>
        {done ? (
          <div className="mt-2 text-[11px] text-faint">✓ {formatDate(unlockedAt)}</div>
        ) : (
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
              <motion.div className="h-full rounded-full bg-gradient-accent" initial={{ width: 0 }} animate={{ width: `${ratio * 100}%` }} transition={{ type: "spring", stiffness: 60, damping: 18, delay: 0.2 }} />
            </div>
            <span className="text-[11px] text-faint tabular">
              {Math.floor(Math.min(progress[0], progress[1]))}/{progress[1]}
            </span>
          </div>
        )}
      </div>
    </motion.div>
  );
}

export function Achievements() {
  const t = useT();
  const s = useLibrary();
  const unlocked = useMemo(() => new Map(s.unlocked.map((u) => [u.id, u.unlockedAt])), [s.unlocked]);
  const ctx = { games: s.games, stats: s.stats, sessions: s.sessions, collections: s.collections, wishlist: s.wishlist, counters: s.counters };
  const sorted = [...ACHIEVEMENTS].sort((a, b) => Number(unlocked.has(b.id)) - Number(unlocked.has(a.id)));
  const done = ACHIEVEMENTS.filter((a) => unlocked.has(a.id)).length;
  return (
    <div className="mx-auto max-w-[1500px] px-8 pt-4 pb-28">
      <div className="flex items-center justify-between gap-6">
        <div>
          <h1 className="font-display text-3xl font-bold text-fg">{t("achievements.title")}</h1>
          <p className="mt-1 text-sm text-muted">{t("achievements.subtitle")}</p>
        </div>
        <div className="glass flex items-center gap-4 rounded-xl px-5 py-3">
          <Ring value={done / ACHIEVEMENTS.length} size={56} stroke={6}>
            <span className="text-[13px] font-bold text-fg">{Math.round((done / ACHIEVEMENTS.length) * 100)}%</span>
          </Ring>
          <div className="text-sm text-fg-soft">{t("achievements.progress", { done, total: ACHIEVEMENTS.length })}</div>
        </div>
      </div>
      <motion.div variants={staggerContainer(0.03, 0.05)} initial="initial" animate="enter" className="mt-8 grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(330px, 1fr))" }}>
        {sorted.map((a) => {
          let progress: [number, number] = [0, 1];
          try {
            progress = a.progress(ctx);
          } catch {
            /* egal */
          }
          return <Badge key={a.id} def={a} unlockedAt={unlocked.get(a.id)} progress={progress} />;
        })}
      </motion.div>
    </div>
  );
}
