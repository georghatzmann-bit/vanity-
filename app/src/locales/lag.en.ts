import type { Dict } from "./de";

/** English texts of the „lag“ namespace (lag detective) – plugged into `en.ts`. */
export const lagEn: Dict["lag"] = {
  title: "Lag detective",
  cause: {
    wifi: "Wi-Fi",
    router: "Home network/router",
    isp: "Line/provider",
    internet: "Internet (beyond your provider)",
    localTraffic: "Traffic on this PC",
    unknown: "unclear",
  },
  summary: {
    none: "No spikes examined",
    headOne: "1 spike examined",
    head: "{n} spikes examined",
    likely: "likely: {list}",
    item: "{n}× {cause}",
    unclear: "{n}× unclear",
  },
};
