/**
 * Demo-Backend: Datei-Export (`export_file`). Im Browser gibt es keinen Speichern-Dialog – die Datei
 * wird über einen Blob-Link mit `<a download>` heruntergeladen (Dateiname aus dem Pfad).
 */
import type { MockHandlers } from "./core";

/** Dateiname aus einem Windows- oder Unix-Pfad */
export const fileNameOf = (path: string) => path.split(/[\\/]/).pop() || "pulsar-export";

/** Bytes als Datei herunterladen (Browser) */
export function downloadBlob(name: string, bytes: Uint8Array, type = "application/octet-stream") {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const exportMock: MockHandlers = {
  export_file: (a) => {
    const headers = (a.headers ?? {}) as Record<string, string>;
    const raw = headers["x-pulsar-path"];
    const path = typeof raw === "string" ? decodeURIComponent(raw) : String(a.path ?? "");
    const bytes = a.bytes instanceof Uint8Array ? a.bytes : new Uint8Array();
    if (bytes.length > 10 * 1024 * 1024) throw new Error("Datei ist zu groß.");
    if (!/\.(png|html|csv|md|txt)$/i.test(path)) throw new Error("Dateityp nicht erlaubt.");
    downloadBlob(fileNameOf(path), bytes);
    return undefined;
  },
};
