/** Netzwerk › Speedtest mit Bufferbloat (aus pages/Network.tsx ausgelagert). */
import { useRef, useState } from "react";
import { Gauge, Play, X } from "lucide-react";
import { api, errorText, listen } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { gradeColor, pingColor } from "@/lib/grade";
import { useT } from "@/lib/i18n";
import type { SpeedProgress, SpeedResult } from "@/lib/types";
import { toast } from "@/store/ui";
import { GradeRing } from "@/components/net/GradeRing";
import { StatTile } from "@/components/net/StatTile";
import { Ring } from "@/components/ui/Ring";
import { Button } from "@shared/ui/Button";
import { ProgressBar } from "@shared/ui/ProgressBar";
import { sound } from "@shared/sound/engine";

export function SpeedPanel() {
  const t = useT();
  const [progress, setProgress] = useState<SpeedProgress | null>(null);
  const [result, setResult] = useState<SpeedResult | null>(() => {
    try {
      const raw = localStorage.getItem("pulsar-speedtest");
      return raw ? (JSON.parse(raw) as SpeedResult) : null;
    } catch {
      return null;
    }
  });
  const [running, setRunning] = useState(false);
  const peak = useRef(0);

  const run = async () => {
    setRunning(true);
    setProgress({ phase: "latency", progress: 0, mbps: null, latencyMs: null });
    peak.current = 0;
    const un = await listen<SpeedProgress>("net://speed", (p) => {
      if (p.mbps) peak.current = Math.max(peak.current, p.mbps);
      setProgress(p);
    });
    try {
      const res = await api.speedtest();
      setResult(res);
      try {
        localStorage.setItem("pulsar-speedtest", JSON.stringify(res));
      } catch {
        /* egal */
      }
      sound.play("success");
    } catch (e) {
      toast({ kind: "error", title: t("toast.error"), text: errorText(e) });
    } finally {
      un();
      setRunning(false);
      setProgress(null);
    }
  };

  const mbps = progress?.mbps ?? null;
  const gaugeMax = Math.max(100, peak.current * 1.2, result?.downloadMbps ?? 0);

  return (
    <div className="mx-auto max-w-[1000px]">
      <p className="text-[13px] text-muted">{t("network.speed.intro")}</p>
      <div className="mt-5 grid grid-cols-[auto_1fr] gap-6">
        <div className="glass flex flex-col items-center justify-center gap-4 rounded-2xl px-8 py-6">
          <Ring value={mbps !== null ? mbps / gaugeMax : result ? 1 : 0} size={200} stroke={14}>
            <div className="text-center">
              <div className="font-display text-4xl font-bold text-fg tabular">{mbps !== null ? Math.round(mbps) : result ? Math.round(result.downloadMbps) : "–"}</div>
              <div className="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{progress ? t(`network.speed.phases.${progress.phase}`) : "Mbit/s"}</div>
            </div>
          </Ring>
          {running ? (
            <Button variant="secondary" icon={<X className="h-4 w-4" />} onClick={() => void api.speedtestCancel()}>
              {t("network.speed.cancel")}
            </Button>
          ) : (
            <Button variant="primary" size="lg" icon={<Play className="h-4 w-4" />} onClick={() => void run()}>
              {t("network.speed.start")}
            </Button>
          )}
          {progress && <ProgressBar value={progress.progress} className="w-full" />}
          {progress?.latencyMs != null && (
            <div className="text-[12px] text-muted tabular">
              {t("network.speed.loaded")}: <span style={{ color: pingColor(progress.latencyMs) }}>{progress.latencyMs.toFixed(0)} ms</span>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-4">
          {result ? (
            <>
              <div className="grid grid-cols-3 gap-3">
                <StatTile label={t("network.speed.download")} value={Math.round(result.downloadMbps)} unit="Mbit/s" icon={<Gauge className="h-3.5 w-3.5" />} />
                <StatTile label={t("network.speed.upload")} value={Math.round(result.uploadMbps)} unit="Mbit/s" />
                <StatTile label={t("network.speed.idle")} value={result.idleLatencyMs.toFixed(1)} unit="ms" color={pingColor(result.idleLatencyMs)} sub={`± ${result.idleJitterMs.toFixed(1)} ms`} />
              </div>
              <div className="glass flex items-center gap-5 rounded-xl p-5">
                <GradeRing grade={result.grade} size={120} label={t("network.speed.bufferbloat")} />
                <div className="flex-1">
                  <div className="font-display text-xl font-bold text-fg">
                    +{Math.round(result.bufferbloatMs)} ms <span className="text-sm font-medium text-muted">{t("network.speed.loaded")}</span>
                  </div>
                  <div className="mt-1 text-[12px] text-muted">{t("network.speed.bufferbloatHint")}</div>
                  <div className="mt-2 text-[13px] text-fg-soft">{t(`network.speed.verdict.${result.grade}`)}</div>
                  <div className="mt-2 text-[11px] text-faint">
                    {t("network.speed.server")}: {result.server} · {t("network.speed.lastResult")}: {formatDateTime(result.at)}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3">
                <StatTile label={t("network.speed.download")} value="–" unit="Mbit/s" icon={<Gauge className="h-3.5 w-3.5" />} />
                <StatTile label={t("network.speed.upload")} value="–" unit="Mbit/s" />
                <StatTile label={t("network.speed.idle")} value="–" unit="ms" />
              </div>
              <div className="glass flex items-center gap-5 rounded-xl p-5">
                <GradeRing grade={null} size={120} label={t("network.speed.bufferbloat")} />
                <div className="flex-1">
                  <div className="font-display text-lg font-bold text-fg">{t("network.speed.notYet")}</div>
                  <div className="mt-0.5 text-[12px] text-muted">{t("network.speed.notYetText")}</div>
                  <div className="mt-2 text-[12px] text-fg-soft">{t("network.speed.bufferbloatHint")}</div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {(["A+", "A", "B", "C", "D", "F"] as const).map((g, i) => (
                      <span key={g} className="rounded-md px-2 py-0.5 text-[11px] font-semibold tabular" style={{ color: gradeColor(g), background: `color-mix(in oklab, ${gradeColor(g)} 15%, transparent)` }}>
                        {g} {["< 5", "< 30", "< 60", "< 200", "< 400", "≥ 400"][i]} ms
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
