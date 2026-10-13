import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { CloudSun, MapPin } from "lucide-react";
import { api } from "@/lib/api";
import { useT, getLanguage } from "@/lib/i18n";
import type { WeatherNow } from "@/lib/types";
import { useSettings } from "@/store/settings";
import { useUI } from "@/store/ui";
import { Widget } from "./Widget";

type Kind = "sun" | "moon" | "partly" | "cloud" | "rain" | "snow" | "storm" | "fog";

function kindFor(code: number, isDay: boolean): Kind {
  if (code === 0) return isDay ? "sun" : "moon";
  if (code <= 2) return "partly";
  if (code === 3) return "cloud";
  if (code === 45 || code === 48) return "fog";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "storm";
  return "cloud";
}

const DESC: Record<Kind, [string, string]> = {
  sun: ["Sonnig", "Sunny"],
  moon: ["Klar", "Clear"],
  partly: ["Teils bewölkt", "Partly cloudy"],
  cloud: ["Bewölkt", "Cloudy"],
  rain: ["Regen", "Rain"],
  snow: ["Schnee", "Snow"],
  storm: ["Gewitter", "Thunderstorm"],
  fog: ["Nebel", "Fog"],
};

/** Animiertes Wettersymbol */
function WeatherIcon({ kind }: { kind: Kind }) {
  const cloud = (x: number, y: number, s = 1, o = 1) => (
    <motion.g animate={{ x: [0, 4, 0] }} transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }} opacity={o}>
      <path d={`M${x} ${y} a${12 * s} ${12 * s} 0 0 1 ${22 * s} -6 a${10 * s} ${10 * s} 0 0 1 ${18 * s} 8 a${8 * s} ${8 * s} 0 0 1 -2 ${16 * s} h-${36 * s} a${9 * s} ${9 * s} 0 0 1 -2 -${18 * s} z`} fill="currentColor" className="text-fg-soft" />
    </motion.g>
  );
  return (
    <svg viewBox="0 0 80 80" className="h-[72px] w-[72px] overflow-visible">
      {(kind === "sun" || kind === "partly") && (
        <motion.g style={{ originX: "40px", originY: "34px" }} animate={{ rotate: 360 }} transition={{ duration: 24, repeat: Infinity, ease: "linear" }}>
          {Array.from({ length: 8 }, (_, i) => (
            <line key={i} x1="40" y1="10" x2="40" y2="16" stroke="#fbbf24" strokeWidth="3" strokeLinecap="round" transform={`rotate(${i * 45} 40 34)`} />
          ))}
          <circle cx="40" cy="34" r="13" fill="#fbbf24" style={{ filter: "drop-shadow(0 0 10px #fbbf24)" }} />
        </motion.g>
      )}
      {kind === "moon" && <path d="M48 18 a18 18 0 1 0 12 30 a14 14 0 1 1 -12 -30 z" fill="#c7d2fe" style={{ filter: "drop-shadow(0 0 10px #a5b4fc)" }} />}
      {(kind === "partly" || kind === "cloud" || kind === "rain" || kind === "snow" || kind === "storm" || kind === "fog") && cloud(18, 46, 1)}
      {kind === "cloud" && cloud(34, 34, 0.7, 0.6)}
      {kind === "rain" &&
        [0, 1, 2].map((i) => (
          <motion.line key={i} x1={28 + i * 10} y1="58" x2={25 + i * 10} y2="66" stroke="#60a5fa" strokeWidth="2.5" strokeLinecap="round" animate={{ y: [0, 10], opacity: [1, 0] }} transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.25 }} />
        ))}
      {kind === "snow" &&
        [0, 1, 2].map((i) => <motion.circle key={i} cx={28 + i * 10} cy="60" r="2.4" fill="#e0f2fe" animate={{ y: [0, 12], opacity: [1, 0] }} transition={{ duration: 1.8, repeat: Infinity, delay: i * 0.5 }} />)}
      {kind === "storm" && <motion.path d="M40 54 l-6 12 h6 l-4 10 l12 -15 h-6 l4 -7 z" fill="#fbbf24" animate={{ opacity: [0, 1, 0, 0] }} transition={{ duration: 2.2, repeat: Infinity, times: [0, 0.05, 0.15, 1] }} />}
      {kind === "fog" && [0, 1].map((i) => <motion.line key={i} x1="16" x2="64" y1={60 + i * 7} y2={60 + i * 7} stroke="currentColor" className="text-muted" strokeWidth="3" strokeLinecap="round" animate={{ x: [0, 5, 0] }} transition={{ duration: 3, repeat: Infinity, delay: i }} />)}
    </svg>
  );
}

export function WeatherWidget() {
  const t = useT();
  const place = useSettings((s) => s.settings.weatherPlace);
  const [data, setData] = useState<WeatherNow | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!place) return;
    let alive = true;
    const load = () =>
      api
        .weather(place.lat, place.lon, place.name)
        .then((w) => alive && (setData(w), setError(false)))
        .catch(() => alive && setError(true));
    void load();
    const id = window.setInterval(load, 15 * 60 * 1000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [place]);

  const lang = getLanguage() === "de" ? 0 : 1;
  const kind = data ? kindFor(data.code, data.isDay) : "partly";

  return (
    <Widget title={t("widgets.weather")} icon={<CloudSun className="h-3.5 w-3.5" />}>
      {!place ? (
        <button type="button" onClick={() => useUI.getState().navigate({ page: "settings", section: "widgets" })} className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-muted transition hover:text-fg">
          <MapPin className="h-6 w-6 text-accent" />
          {t("widgets.weatherSetup")}
        </button>
      ) : error && !data ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">{t("widgets.weatherError")}</div>
      ) : !data ? (
        <div className="flex flex-1 flex-col gap-2">
          <div className="skeleton h-14 w-24 rounded-lg" />
          <div className="skeleton h-4 w-32 rounded" />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-between gap-2">
          <div>
            <div className="font-display text-[44px] leading-none font-bold text-fg tabular">{Math.round(data.temperature)}°</div>
            <div className="mt-2 text-sm font-medium text-fg-soft">
              {DESC[kind][lang]} · {t("widgets.feelsLike", { t: `${Math.round(data.apparent)}°` })}
            </div>
            <div className="text-[12px] text-muted">
              {data.place} · ↑{Math.round(data.high)}° ↓{Math.round(data.low)}°
            </div>
          </div>
          <WeatherIcon kind={kind} />
        </div>
      )}
    </Widget>
  );
}
