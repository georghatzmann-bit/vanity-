import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";

/** true, wenn die Oberfläche im echten Launcher-Fenster läuft (nicht im Browser-Vorschau-Modus). */
export const inTauri = isTauri();

export async function minimizeWindow() {
  if (inTauri) await getCurrentWindow().minimize();
}

export async function toggleMaximizeWindow() {
  if (inTauri) await getCurrentWindow().toggleMaximize();
}

export async function closeWindow() {
  if (inTauri) await getCurrentWindow().close();
}

/** Ruft `onChange` auf, wenn das Fenster maximiert oder wiederhergestellt wird. */
export function watchMaximized(onChange: (maximized: boolean) => void): () => void {
  if (!inTauri) return () => {};
  const win = getCurrentWindow();
  let disposed = false;
  let unlisten: (() => void) | undefined;
  win.isMaximized().then((m) => !disposed && onChange(m));
  win
    .onResized(async () => {
      if (!disposed) onChange(await win.isMaximized());
    })
    .then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/** Öffnet einen Link im normalen Browser. */
export async function openExternal(url: string) {
  if (inTauri) await openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
