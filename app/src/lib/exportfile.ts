/**
 * Datei-Export aus der Oberfläche (PNG-Bildkarte, HTML-/CSV-Bericht). Vertrag: docs/API.md, „Datei-Export“.
 * 1. Windows-Speichern-Dialog (`saveFile`); Abbruch → nichts passiert. 2. `api.exportFile(path, bytes)` (Roh-IPC).
 * 3. Meldung „Gespeichert“ mit „Im Ordner zeigen“. Im Browser (Demo): Download über einen Blob-Link.
 */
import { isTauri } from "@shared/lib/env";
import { api, errorText } from "./api";
import { saveFile } from "./dialog";
import { t } from "./i18n";
import { backendText } from "./netauto";
import { toast } from "@/store/ui";

export interface FileFilter {
  name: string;
  extensions: string[];
}

export const PNG_FILTER: FileFilter = { name: "PNG", extensions: ["png"] };
export const HTML_FILTER: FileFilter = { name: "HTML", extensions: ["html"] };
export const CSV_FILTER: FileFilter = { name: "CSV", extensions: ["csv"] };

/** Höchstens so viele Zeichen hat der Spielname im Dateinamen */
export const SLUG_MAX = 40;

/** Name für Dateinamen: Kleinbuchstaben, nur a–z, 0–9 und „-“, höchstens 40 Zeichen */
export function slug(name: string, fallback = "spiel"): string {
  const s = name
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return s || fallback;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** JJJJ-MM-TT in Ortszeit */
export const localDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** JJJJ-MM-TT-HHMM in Ortszeit */
export const localDateTime = (ms: number) => {
  const d = new Date(ms);
  return `${localDate(ms)}-${pad(d.getHours())}${pad(d.getMinutes())}`;
};

/** `pulsar-match-<spiel>-<JJJJ-MM-TT-HHMM>.png` */
export const matchCardFileName = (gameName: string, start: number) => `pulsar-match-${slug(gameName)}-${localDateTime(start)}.png`;

/** `pulsar-anbieter-protokoll-<von>_bis_<bis>.html|csv` */
export const ispLogFileName = (from: number, to: number, ext: "html" | "csv") => `pulsar-anbieter-protokoll-${localDate(from)}_bis_${localDate(to)}.${ext}`;

/** Text als UTF-8; CSV mit BOM (damit Excel Umlaute richtig liest) */
export function textBytes(text: string, bom = false): Uint8Array {
  return new TextEncoder().encode(bom ? `﻿${text}` : text);
}

/** Bytes speichern. Liefert true, wenn gespeichert (bzw. im Browser heruntergeladen) wurde. */
export async function exportBytes(defaultName: string, filter: FileFilter, bytes: Uint8Array): Promise<boolean> {
  if (!isTauri()) {
    const { downloadBlob } = await import("./mock/export");
    downloadBlob(defaultName, bytes);
    return true;
  }
  const path = await saveFile(defaultName, [filter]);
  if (!path) return false;
  try {
    await api.exportFile(path, bytes);
  } catch (e) {
    toast({ kind: "error", title: t("toast.error"), text: backendText(errorText(e), t) });
    return false;
  }
  toast({ kind: "success", title: t("common.saved"), text: path, action: { label: t("common.showInFolder"), run: () => void api.revealPath(path).catch(() => undefined) } });
  return true;
}

/** Text speichern (UTF-8; CSV automatisch mit BOM) */
export function exportText(defaultName: string, filter: FileFilter, text: string): Promise<boolean> {
  const csv = filter.extensions.includes("csv") || defaultName.toLowerCase().endsWith(".csv");
  return exportBytes(defaultName, filter, textBytes(text, csv));
}
