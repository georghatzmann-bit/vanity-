import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";

/** true when the UI runs in the real launcher window (not in the browser preview). */
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

/** Calls `read` once and then after every resize of the window (maximize, restore, minimize …). */
function watchWindowState(read: () => Promise<void>): () => void {
  if (!inTauri) return () => {};
  const win = getCurrentWindow();
  let disposed = false;
  let unlisten: (() => void) | undefined;
  read().catch(() => {});
  win
    .onResized(async () => {
      if (!disposed) await read().catch(() => {});
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

/** Calls `onChange` when the window is maximized or restored. */
export function watchMaximized(onChange: (maximized: boolean) => void): () => void {
  const win = inTauri ? getCurrentWindow() : null;
  return watchWindowState(async () => {
    if (win) onChange(await win.isMaximized());
  });
}

/** Calls `onChange` when the window is minimized or comes back (used to pause animations). */
export function watchMinimized(onChange: (minimized: boolean) => void): () => void {
  const win = inTauri ? getCurrentWindow() : null;
  return watchWindowState(async () => {
    if (win) onChange(await win.isMinimized());
  });
}

/** Opens a link in the normal browser. */
export async function openExternal(url: string) {
  if (inTauri) await openUrl(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
