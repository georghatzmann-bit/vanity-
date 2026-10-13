import { create } from "zustand";
import { api, errorText, listen } from "@/lib/api";
import { t } from "@/lib/i18n";
import { AUTO_TWEAKS, backendText, isManualProvider, pickBestDns, providerName, restoreDeclined, restoreProblems as restoreProblemsOf, type DnsPick } from "@/lib/netauto";
import type { AutoReport, DnsConfig, DnsProgress, DnsResult, Tweak, TweakId } from "@/lib/types";
import { toast } from "./ui";
import { sound } from "@shared/sound/engine";

/**
 * „Netzwerk automatisch optimieren“ als Ablauf:
 * idle → measuring (DNS-Dienste vergleichen) → plan (Vorschlag, je Punkt ein Schalter) → applying (Windows fragt) → result.
 * Liegt im Store, damit ein laufender Vorgang einen Seitenwechsel übersteht.
 */
export type NetAutoPhase = "idle" | "measuring" | "plan" | "applying" | "result" | "error";

export interface NetAutoChoice {
  dns: boolean;
  nagle: boolean;
  netThrottle: boolean;
}

interface NetAutoState {
  phase: NetAutoPhase;
  progress: DnsProgress | null;
  results: DnsResult[];
  pick: DnsPick | null;
  /** DNS der Hauptverbindung (null = keine Verbindung oder unbekannt) */
  dns: DnsConfig | null;
  /** Zustand von nagle und netThrottle */
  tweaks: Tweak[];
  choice: NetAutoChoice;
  /** Was mit „Jetzt einstellen“ angefordert wurde (für die Ergebnisliste) */
  requested: { provider: string | null; tweaks: TweakId[] } | null;
  report: AutoReport | null;
  error: string | null;
  /** Woran der Fehler hing – bestimmt „Erneut versuchen“ */
  errorStep: "measure" | "apply" | null;
  restoring: boolean;
  /**
   * Gemeinsame Sperre: Gerade läuft eine Änderung an Windows (Automatik, DNS einstellen/zurückstellen,
   * Optimierungen anwenden/zurückstellen). Solange sind alle Knöpfe und Schalter gesperrt, die Windows ändern –
   * sonst könnten sich zwei Änderungen überholen und eine Sicherung verloren gehen.
   */
  windowsBusy: boolean;
  /** Wird nach jeder Änderung hochgezählt, damit Seiten ihre Daten neu laden */
  version: number;

  /** DNS und Netzwerk-Optimierungen neu lesen (für den Ruhezustand) */
  refresh: () => Promise<void>;
  /**
   * Etwas wurde außerhalb der Karte geändert (Knopf oben auf der Seite, Schalter in der Liste, DNS-Tab):
   * Plan und Ergebnis sind dann veraltet → zurück in den Ruhezustand und neu laden.
   */
  externalChange: () => Promise<void>;
  start: () => Promise<void>;
  setChoice: (key: keyof NetAutoChoice, value: boolean) => void;
  apply: () => Promise<void>;
  restore: () => Promise<void>;
  reset: () => void;
}

const isNetTweak = (tw: Tweak) => (AUTO_TWEAKS as readonly string[]).includes(tw.id);

/** Kann der Plan den DNS überhaupt ändern? */
export function dnsChangePossible(pick: DnsPick | null, dns: DnsConfig | null): boolean {
  return !!pick?.change && !!pick.best && !!dns?.canChange && dns.provider !== pick.best.id;
}

/** Was hat Pulsar gerade geändert (DNS gesichert – auch an einer anderen Verbindung –, nagle/netThrottle gesichert)? */
export function pulsarChanges(dns: DnsConfig | null, tweaks: Tweak[]): { dns: boolean; tweaks: Tweak[] } {
  return { dns: !!dns?.changedByPulsar || (dns?.otherBackups ?? []).length > 0, tweaks: tweaks.filter((tw) => isNetTweak(tw) && tw.canRevert) };
}

/**
 * Kann Pulsar diese Netzwerk-Optimierung jetzt einschalten? Nicht, wenn sie „aus“ zeigt, aber schon eine Sicherung
 * hat (z. B. „Nagle“ an einer anderen Verbindung): Das Backend würde das ablehnen – erst zurückstellen.
 */
export const canSwitchOn = (tw: Tweak | undefined): boolean => !!tw && tw.state === "off" && !tw.canRevert;

/** Was ist nach net_auto_restore übrig geblieben? (Gründe als übersetzte Sätze) */
export const restoreProblems = (rep: AutoReport): string[] => restoreProblemsOf(rep, t("optimize.auto.restoreDnsLeft")).map((m) => backendText(m, t));

/**
 * Führt eine Änderung an Windows unter der gemeinsamen Sperre aus.
 * Läuft schon eine, passiert nichts (Rückgabe null) – die Knöpfe sind dann ohnehin gesperrt.
 */
export async function withWindowsLock<T>(fn: () => Promise<T>): Promise<T | null> {
  if (useNetAuto.getState().windowsBusy) return null;
  useNetAuto.setState({ windowsBusy: true });
  try {
    return await fn();
  } finally {
    useNetAuto.setState({ windowsBusy: false });
  }
}

/** Sind Knöpfe, die Windows ändern, gerade gesperrt? (Änderung läuft oder die Automatik misst gerade) */
export const useWindowsLocked = (): boolean => useNetAuto((st) => st.windowsBusy || st.phase === "measuring");

export const useNetAuto = create<NetAutoState>((set, get) => ({
  phase: "idle",
  progress: null,
  results: [],
  pick: null,
  dns: null,
  tweaks: [],
  choice: { dns: true, nagle: true, netThrottle: true },
  requested: null,
  report: null,
  error: null,
  errorStep: null,
  restoring: false,
  windowsBusy: false,
  version: 0,

  refresh: async () => {
    const [dns, tweaks] = await Promise.all([api.dnsCurrent().catch(() => null), api.tweaks().catch(() => [] as Tweak[])]);
    set({ dns, tweaks: tweaks.filter(isNetTweak) });
  },

  externalChange: async () => {
    const phase = get().phase;
    if (phase === "plan" || phase === "result" || phase === "error") {
      set({ phase: "idle", report: null, requested: null, pick: null, results: [], error: null, errorStep: null, progress: null });
    }
    await get().refresh();
    set({ version: get().version + 1 });
  },

  start: async () => {
    const { phase, windowsBusy } = get();
    if (phase === "measuring" || phase === "applying" || windowsBusy) return;
    set({ phase: "measuring", progress: { done: 0, total: 8 }, error: null, errorStep: null, report: null, requested: null, pick: null, results: [] });
    let un: (() => void) | null = null;
    try {
      un = await listen<DnsProgress>("net://dns", (p) => set({ progress: p }));
      // Der Vertrag rechnet mit 3 Runden (Runde 1 = neue Adressen, danach bekannte)
      const results = await api.dnsBenchmark(3);
      // Zustand erst nach dem Vergleich lesen, damit der Vorschlag zum jetzigen Stand passt
      const [dns, tweaks] = await Promise.all([api.dnsCurrent().catch(() => null), api.tweaks().catch(() => [] as Tweak[])]);
      const pick = pickBestDns(results);
      const net = tweaks.filter(isNetTweak);
      const off = (id: TweakId) => canSwitchOn(net.find((tw) => tw.id === id));
      set({
        phase: "plan",
        results,
        pick,
        dns,
        tweaks: net,
        // Bewusst gewählte Dienste (AdGuard, Mullvad, DNS0.eu) nur auf ausdrücklichen Wunsch ersetzen
        choice: { dns: dnsChangePossible(pick, dns) && !isManualProvider(dns?.provider), nagle: off("nagle"), netThrottle: off("netThrottle") },
        progress: null,
      });
      sound.play("success");
    } catch (e) {
      set({ phase: "error", error: errorText(e), errorStep: "measure", progress: null });
      sound.play("error");
    } finally {
      un?.();
    }
  },

  setChoice: (key, value) => set({ choice: { ...get().choice, [key]: value } }),

  apply: async () => {
    const { pick, dns, choice, tweaks, phase, windowsBusy } = get();
    if ((phase !== "plan" && phase !== "result") || windowsBusy) return;
    const provider = choice.dns && dnsChangePossible(pick, dns) && pick?.best ? pick.best.id : null;
    const ids = AUTO_TWEAKS.filter((id) => choice[id as keyof NetAutoChoice] && canSwitchOn(tweaks.find((tw) => tw.id === id)));
    if (!provider && !ids.length) return;
    set({ phase: "applying", windowsBusy: true, requested: { provider, tweaks: ids }, report: null, error: null, errorStep: null });
    try {
      const report = await api.autoOptimize(provider, ids);
      const [fresh, tw] = await Promise.all([report.dns ? Promise.resolve(report.dns) : api.dnsCurrent().catch(() => null), api.tweaks().catch(() => [] as Tweak[])]);
      set({ phase: "result", report, dns: fresh, tweaks: tw.filter(isNetTweak), version: get().version + 1 });
      const problems = (report.dnsError ? 1 : 0) + report.failed.length;
      sound.play(report.declined ? "notify" : problems ? "error" : "achievement");
    } catch (e) {
      set({ phase: "error", error: errorText(e), errorStep: "apply" });
      sound.play("error");
    } finally {
      set({ windowsBusy: false });
    }
  },

  restore: async () => {
    if (get().restoring || get().windowsBusy) return;
    set({ restoring: true, windowsBusy: true });
    try {
      const rep = await api.autoRestore();
      await get().refresh();
      const failed = restoreProblems(rep);
      if (restoreDeclined(rep)) {
        toast({ kind: "info", title: t("optimize.auto.restoreDeclined"), text: t("optimize.auto.restoreDeclinedText") });
      } else if (failed.length) {
        // „Teilweise“ nur, wenn auch wirklich etwas zurückgestellt wurde
        const some = rep.dnsChanged || rep.applied.length > 0;
        toast({ kind: "warning", title: t(some ? "optimize.auto.restorePartial" : "optimize.auto.restoreFailed"), text: [...new Set(failed)].join(" · ") });
      } else if (!rep.dnsChanged && !rep.applied.length) {
        toast({ kind: "info", title: t("optimize.auto.nothingToRestore") });
      } else {
        const parts = [
          ...(rep.dnsChanged ? [t("optimize.auto.restoredDns", { servers: rep.dns?.dhcp ? t("network.dns.dhcp") : (rep.dns?.servers.join(", ") ?? "–") })] : []),
          ...rep.applied.map((id) => t(`optimize.items.${id}.name`)),
        ];
        toast({ kind: "success", title: t("optimize.auto.restored"), text: parts.join(" · ") + (rep.restart ? ` · ${t("optimize.auto.restartShort")}` : "") });
      }
      // Nach dem Zurückstellen zurück in den Ruhezustand – es sei denn, es wurde abgelehnt
      if (!rep.declined) set({ phase: "idle", report: null, requested: null, version: get().version + 1 });
    } catch (e) {
      toast({ kind: "error", title: t("toast.error"), text: backendText(errorText(e), t) });
      // Unklar, was passiert ist: kein altes Ergebnis stehen lassen, sondern den echten Zustand zeigen
      await get().refresh();
      set({ phase: "idle", report: null, requested: null, version: get().version + 1 });
    } finally {
      set({ restoring: false, windowsBusy: false });
    }
  },

  reset: () => {
    const phase = get().phase;
    if (phase === "measuring" || phase === "applying") return;
    set({ phase: "idle", report: null, requested: null, error: null, errorStep: null, progress: null });
  },
}));

/** Anzeigename des DNS (Dienst, Router oder Server) */
export function dnsLabel(dns: DnsConfig | null): string {
  if (!dns) return "–";
  if (dns.provider) return providerName(dns.provider);
  if (dns.dhcp) return t("network.dns.router");
  return t("network.dns.customServer");
}
