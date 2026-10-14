/** Netzwerk › Route: Routen-Analyse Station für Station (aus pages/Network.tsx ausgelagert). */
import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Cable, Globe, Route, Wifi } from "lucide-react";
import { api, errorText, listen } from "@/lib/api";
import { pingColor } from "@/lib/grade";
import { useT } from "@/lib/i18n";
import type { TraceHop, TraceResult } from "@/lib/types";
import { useNet } from "@/store/net";
import { toast } from "@/store/ui";
import { Button } from "@shared/ui/Button";
import { cn } from "@shared/lib/cn";
import { spring } from "@shared/design/motion";
import { sound } from "@shared/sound/engine";

export function RoutePanel() {
  const t = useT();
  const targetLabel = useNet((s) => s.target?.host ?? "");
  const [host, setHost] = useState(targetLabel || "dynamodb.eu-central-1.amazonaws.com");
  const [hops, setHops] = useState<TraceHop[]>([]);
  const [result, setResult] = useState<TraceResult | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setHops([]);
    setResult(null);
    setRunning(true);
    const un = await listen<TraceHop>("net://trace", (h) => setHops((prev) => [...prev.filter((x) => x.hop !== h.hop), h].sort((a, b) => a.hop - b.hop)));
    try {
      const res = await api.traceroute(host.trim(), 30);
      setResult(res);
      setHops(res.hops);
      sound.play("success");
    } catch (e) {
      toast({ kind: "error", title: t("toast.error"), text: errorText(e) });
    } finally {
      un();
      setRunning(false);
    }
  };

  const verdict = useMemo(() => {
    if (!result) return null;
    let biggest: { hop: TraceHop; jump: number } | null = null;
    let prev = 0;
    for (const h of result.hops) {
      const ok = h.rtts.filter((v): v is number => v !== null);
      if (!ok.length) continue;
      const med = ok.sort((a, b) => a - b)[Math.floor(ok.length / 2)];
      const jump = med - prev;
      if (!biggest || jump > biggest.jump) biggest = { hop: h, jump };
      prev = med;
    }
    if (!biggest || biggest.jump < 15) return { text: t("network.route.verdictFine"), hop: null };
    const key = biggest.hop.zone === "lan" ? "verdictLan" : biggest.hop.zone === "isp" ? "verdictIsp" : "verdictInternet";
    return { text: `${t(`network.route.${key}`)} ${t("network.route.biggestJump", { ms: Math.round(biggest.jump), hop: biggest.hop.hop })}`, hop: biggest.hop.hop };
  }, [result, t]);

  const maxRtt = Math.max(30, ...hops.flatMap((h) => h.rtts.filter((v): v is number => v !== null)));

  return (
    <div className="mx-auto max-w-[900px]">
      <p className="text-[13px] text-muted">{t("network.route.intro")}</p>
      <div className="mt-4 flex gap-2">
        <input value={host} onChange={(e) => setHost(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !running && void run()} className="input h-11 flex-1" placeholder={t("network.route.host")} spellCheck={false} />
        <Button variant="primary" size="lg" loading={running} icon={<Route className="h-4 w-4" />} onClick={() => void run()}>
          {running ? t("network.route.running") : t("network.route.start")}
        </Button>
      </div>
      {/* Schnellziele */}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px]">
        <span className="text-faint">{t("network.route.quick")}</span>
        {[
          [targetLabel, t("network.route.quickTarget")],
          ["1.1.1.1", "Cloudflare"],
          ["8.8.8.8", "Google"],
          ["steamcommunity.com", "Steam"],
        ]
          .filter(([h]) => h)
          .map(([h, label]) => (
            <button key={h} type="button" disabled={running} onClick={() => setHost(h)} className={cn("rounded-full border px-3 py-1 transition disabled:opacity-40", host === h ? "border-transparent bg-accent/15 text-fg" : "border-line text-muted hover:text-fg")}>
              {label}
            </button>
          ))}
      </div>

      {/* Noch keine Analyse: kleine Grafik, was die Zonen bedeuten */}
      {!hops.length && !running && (
        <div className="glass mt-5 rounded-xl px-6 py-6">
          <div className="relative flex items-start justify-between gap-2">
            <div className="absolute top-5 right-[12%] left-[12%] border-t-2 border-dashed border-line-strong" />
            {(["lan", "isp", "internet", "target"] as const).map((z, i) => (
              <motion.div key={z} className="relative flex flex-1 flex-col items-center text-center" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.08 }}>
                <span className={cn("grid h-10 w-10 place-items-center rounded-full ring-4 ring-[var(--nv-bg-elev)]", z === "lan" ? "bg-success/20 text-success-fg" : z === "isp" ? "bg-accent/20 text-accent-text" : z === "target" ? "bg-gradient-accent text-accent-fg" : "bg-surface-3 text-muted")}>
                  {z === "lan" ? <Wifi className="h-4 w-4" /> : z === "isp" ? <Cable className="h-4 w-4" /> : z === "internet" ? <Globe className="h-4 w-4" /> : <Route className="h-4 w-4" />}
                </span>
                <span className="mt-2 text-[12px] font-semibold text-fg">{t(`network.route.zones.${z}`)}</span>
                <span className="mt-0.5 max-w-[170px] text-[11px] leading-snug text-muted">{t(`network.route.zoneHint.${z}`)}</span>
              </motion.div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-5 flex flex-col gap-1.5">
        <AnimatePresence>
          {hops.map((h) => {
            const ok = h.rtts.filter((v): v is number => v !== null);
            const med = ok.length ? ok.sort((a, b) => a - b)[Math.floor(ok.length / 2)] : null;
            const highlight = verdict?.hop === h.hop;
            return (
              <motion.div key={h.hop} className={cn("glass flex items-center gap-3 rounded-lg px-3 py-2", highlight && "shadow-[inset_0_0_0_1px_var(--nv-warning)]")} initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} transition={spring.gentle}>
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-2 text-[11px] font-bold text-muted tabular">{h.hop}</span>
                <span className={cn("w-24 shrink-0 rounded-full px-2 py-0.5 text-center text-[10px] font-semibold uppercase", h.zone === "lan" ? "bg-success/15 text-success-fg" : h.zone === "isp" ? "bg-accent/15 text-accent-text" : h.zone === "target" ? "bg-accent-3/20 text-fg" : "bg-surface-3 text-muted")}>{t(`network.route.zones.${h.zone}`)}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] text-fg tabular">{h.address ?? "*"}</div>
                  {h.hostname && <div className="truncate text-[11px] text-muted">{h.hostname}</div>}
                </div>
                <div className="flex w-56 items-center gap-2">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
                    {med !== null && <motion.div className="h-full rounded-full" style={{ background: pingColor(med) }} initial={{ width: 0 }} animate={{ width: `${Math.min(100, (med / maxRtt) * 100)}%` }} />}
                  </div>
                  <span className="w-16 text-right text-[12px] font-semibold tabular" style={{ color: med === null ? "var(--nv-faint)" : pingColor(med) }}>
                    {med === null ? t("network.route.noReply") : `${med.toFixed(1)} ms`}
                  </span>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
      {result && verdict && (
        <motion.div className="mt-4 rounded-xl bg-gradient-soft p-4 text-[13px] text-fg ring-1 ring-accent/30" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <div className="font-semibold">{result.reached ? t("network.route.reached", { n: result.hops.length }) : t("network.route.notReached", { n: result.hops.length })}</div>
          <div className="mt-1 text-muted">{verdict.text}</div>
        </motion.div>
      )}
    </div>
  );
}
