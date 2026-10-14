/**
 * Cockpit › Live-Ping-Karte: Knopf „Hör dein Netz“ (Kopfhörer, an/aus, kleine Pegelanzeige).
 * Startet nur per Klick (Autoplay-Regel); aus, solange der Monitor pausiert. Vertrag: docs/API.md, „Hör dein Netz“.
 */
import { motion } from "motion/react";
import { Headphones, VolumeX } from "lucide-react";
import { useT } from "@/lib/i18n";
import { sonarGain } from "@/lib/sonar";
import { useNet } from "@/store/net";
import { useSettings } from "@/store/settings";
import { useSonar, type SonarPulse } from "@/store/sonar";
import { cn } from "@shared/lib/cn";

const BARS = [0.25, 0.5, 0.75, 1];

/** Vier Balken: so viele leuchten, wie der Puls laut war; Aussetzer = leere Balken (rot) */
function Meter({ pulse, silent }: { pulse: SonarPulse | null; silent: boolean }) {
  const t = useT();
  const level = pulse && !pulse.dropped && !silent ? pulse.level : 0;
  const label = pulse?.dropped ? t("sonar.dropped") : pulse && pulse.level > 0.99 ? t("sonar.accent") : undefined;
  return (
    <motion.span
      key={pulse?.seq ?? 0}
      initial={{ opacity: 1 }}
      animate={{ opacity: pulse ? 0.45 : 0.3 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
      className="flex h-3.5 items-end gap-[2px]"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      data-testid="sonar-meter"
      data-level={level.toFixed(2)}
      data-dropped={pulse?.dropped ? "1" : "0"}
    >
      {BARS.map((b) => (
        <span
          key={b}
          className={cn("w-[3px] rounded-[1px]", pulse?.dropped ? "border border-danger/70 bg-transparent" : level >= b - 0.01 ? "bg-accent" : "bg-line-strong")}
          style={{ height: `${Math.round(b * 100)}%` }}
        />
      ))}
    </motion.span>
  );
}

export function SonarButton() {
  const t = useT();
  const on = useSonar((s) => s.on);
  const pulse = useSonar((s) => s.pulse);
  const audible = useSonar((s) => s.audible);
  const monitorOn = useNet((s) => s.monitorOn);
  const silent = useSettings((s) => sonarGain(s.settings) <= 0);
  const disabled = !monitorOn && !on;
  const status = disabled ? t("sonar.monitorOff") : on ? t("sonar.turnOff") : t("sonar.turnOn");
  const notes = [silent ? t("sonar.muted") : null, on && !audible ? t("sonar.blocked") : null, t("sonar.legend")].filter(Boolean);
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={on}
      aria-label={status}
      title={`${status}\n${notes.join("\n")}`}
      data-testid="sonar-button"
      onClick={() => useSonar.getState().toggle()}
      className={cn(
        "flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2 transition-colors",
        on ? "border-accent/60 bg-accent/12 text-accent" : "border-line text-muted hover:border-line-strong hover:text-fg",
        disabled && "cursor-not-allowed opacity-50 hover:border-line hover:text-muted",
      )}
    >
      <Headphones className="h-4 w-4" />
      {on && (silent || !audible ? <VolumeX className="h-3.5 w-3.5 text-warning" /> : <Meter pulse={pulse} silent={silent} />)}
    </button>
  );
}
