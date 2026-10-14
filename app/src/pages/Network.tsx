import { AnimatePresence, motion } from "motion/react";
import { Activity, Gauge, Globe, Route, Stethoscope, Wifi, WifiCog } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useUI, type NetworkTab } from "@/store/ui";
import { Tabs } from "@/components/ui/Tabs";
import { staggerContainer, staggerItem } from "@shared/design/motion";
import { ConnectionPanel } from "./network/ConnectionPanel";
import { DiagnosePanel } from "./network/DiagnosePanel";
import { DnsPanel } from "./network/DnsPanel";
import { RegionsPanel } from "./network/RegionsPanel";
import { RoutePanel } from "./network/RoutePanel";
import { SpeedPanel } from "./network/SpeedPanel";
import { WifiPanel } from "./network/WifiPanel";

// ---------------------------------------------------------------------------------------------
const TABS: { value: NetworkTab; icon: React.ReactNode }[] = [
  { value: "regions", icon: <Globe className="h-4 w-4" /> },
  { value: "route", icon: <Route className="h-4 w-4" /> },
  { value: "dns", icon: <Activity className="h-4 w-4" /> },
  { value: "speed", icon: <Gauge className="h-4 w-4" /> },
  { value: "connection", icon: <Wifi className="h-4 w-4" /> },
  { value: "wifi", icon: <WifiCog className="h-4 w-4" /> },
  { value: "diagnose", icon: <Stethoscope className="h-4 w-4" /> },
];

/** Netzwerk-Seite mit sieben Werkzeugen (die Reiter liegen unter ./network/) */
export function Network({ section }: { section?: string }) {
  const t = useT();
  const tab = (TABS.some((x) => x.value === section) ? section : "regions") as NetworkTab;
  const setTab = (v: NetworkTab) => useUI.getState().navigate({ page: "network", section: v });
  return (
    <motion.div className="mx-auto max-w-[1400px] px-8 pt-3 pb-24" variants={staggerContainer(0.04)} initial="initial" animate="enter">
      <motion.div variants={staggerItem}>
        <h1 className="font-display text-3xl font-bold text-fg">{t("network.title")}</h1>
        <p className="mt-1 text-sm text-muted">{t("network.subtitle")}</p>
      </motion.div>
      <motion.div variants={staggerItem}>
        <Tabs value={tab} onChange={setTab} className="mt-4 mb-6" tabs={TABS.map((x) => ({ value: x.value, label: <span className="flex items-center gap-2">{x.icon}{t(`network.tabs.${x.value}`)}</span> }))} />
      </motion.div>
      <AnimatePresence mode="wait">
        <motion.div key={tab} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22 }}>
          {tab === "regions" && <RegionsPanel />}
          {tab === "route" && <RoutePanel />}
          {tab === "dns" && <DnsPanel />}
          {tab === "speed" && <SpeedPanel />}
          {tab === "connection" && <ConnectionPanel />}
          {tab === "wifi" && <WifiPanel />}
          {tab === "diagnose" && <DiagnosePanel />}
        </motion.div>
      </AnimatePresence>
    </motion.div>
  );
}
