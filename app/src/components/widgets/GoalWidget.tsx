import { Target } from "lucide-react";
import { formatDuration } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { todaySeconds } from "@/lib/stats";
import { useNow } from "@/hooks/useNow";
import { useLibrary } from "@/store/library";
import { useSettings } from "@/store/settings";
import { Ring } from "../ui/Ring";
import { Widget } from "./Widget";

export function GoalWidget() {
  const t = useT();
  const sessions = useLibrary((s) => s.sessions);
  const running = useLibrary((s) => s.running);
  const { dailyGoalMode, dailyGoalMinutes } = useSettings((s) => s.settings);
  const now = useNow(15000);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const live = [...running.values()].reduce((a, r) => a + Math.max(0, (now - Math.max(r.startedAt, today.getTime())) / 1000), 0);
  const played = todaySeconds(sessions, now) + live;
  const goal = Math.max(1, dailyGoalMinutes * 60);
  const ratio = played / goal;
  const isLimit = dailyGoalMode === "limit";
  const over = isLimit && ratio >= 1;
  const left = formatDuration(Math.max(0, goal - played));

  return (
    <Widget title={t("widgets.goal")} icon={<Target className="h-3.5 w-3.5" />}>
      <div className="flex flex-1 items-center gap-4">
        <Ring value={Math.min(1, ratio)} size={92} stroke={8} color={over ? "var(--nv-warning)" : !isLimit && ratio >= 1 ? "var(--nv-success)" : undefined}>
          <div className="text-center">
            <div className="text-lg font-bold text-fg tabular">{Math.round(Math.min(ratio, 9.99) * 100)}%</div>
          </div>
        </Ring>
        <div className="min-w-0">
          <div className="font-display text-xl font-bold text-fg">{formatDuration(played)}</div>
          <div className="text-[12px] text-muted">{t("widgets.goalOf", { total: formatDuration(goal) })}</div>
          <div className="mt-2 text-[12px] leading-snug font-medium" style={{ color: over ? "var(--nv-warning)" : !isLimit && ratio >= 1 ? "var(--nv-success)" : "var(--nv-fg-soft)" }}>
            {isLimit ? (over ? t("widgets.limitReached") : t("widgets.limitLeft", { left })) : ratio >= 1 ? t("widgets.goalReached") : t("widgets.goalLeft", { left })}
          </div>
        </div>
      </div>
    </Widget>
  );
}
