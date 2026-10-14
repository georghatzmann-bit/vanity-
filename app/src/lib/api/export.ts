/** Datei-Export (`export_file`): Bytes als Roh-IPC, Zielpfad im Header. Vertrag: docs/API.md, „Datei-Export“. */
import { call } from "../api";

/** Header mit dem Zielpfad (URI-kodiert) */
export const EXPORT_PATH_HEADER = "x-pulsar-path";

export const exportApi = {
  /** Bytes nach `path` schreiben (Pfad aus dem Speichern-Dialog; png/html/csv/md/txt, höchstens 10 MiB) */
  exportFile: (path: string, bytes: Uint8Array) => call<void>("export_file", bytes, { headers: { [EXPORT_PATH_HEADER]: encodeURIComponent(path) } }),
};
