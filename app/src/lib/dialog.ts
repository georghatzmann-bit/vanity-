import { isTauri } from "@shared/lib/env";
import { t } from "./i18n";

/** Ordner auswählen (Windows-Dialog). Im Browser: einfache Eingabe als Ersatz. */
export async function pickFolder(title?: string): Promise<string | null> {
  if (!isTauri()) return window.prompt(title ?? t("common.browse"), "C:\\Spiele") || null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ directory: true, multiple: false, title });
  return typeof r === "string" ? r : null;
}

export async function pickFile(opts: { title?: string; filters?: { name: string; extensions: string[] }[] } = {}): Promise<string | null> {
  if (!isTauri()) return window.prompt(opts.title ?? t("common.browse"), "C:\\Games\\game.exe") || null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ directory: false, multiple: false, title: opts.title, filters: opts.filters });
  return typeof r === "string" ? r : null;
}

export async function saveFile(defaultPath: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null> {
  if (!isTauri()) return window.prompt("Speichern unter", defaultPath) || null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return (await save({ defaultPath, filters })) ?? null;
}

export const IMAGE_FILTERS = [{ name: "Bilder", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif", "ico"] }];
export const EXE_FILTERS = [
  { name: "Programme & Verknüpfungen", extensions: ["exe", "lnk", "url", "bat", "cmd"] },
  { name: "Alle Dateien", extensions: ["*"] },
];
