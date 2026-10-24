// Ressourcen-Ordner finden und den Daten-Ordner beim ersten Start befüllen.
import fs from "node:fs";
import path from "node:path";

/**
 * Ordner mit den mitgelieferten LawinServer-Daten (profiles/, responses/, CloudStorage/, Config/, public/).
 * Gebaut liegt er neben dist/main.js; beim Ausführen aus dem Quellcode (src/) ist es ../lawinserver.
 * Bewusst relativ zur Programmdatei und nicht zum Arbeitsordner.
 */
export function findResourceDir(baseDir: string): string {
  const candidates = [baseDir, path.join(baseDir, "..", "lawinserver")];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "profiles")) && fs.existsSync(path.join(dir, "responses"))) return dir;
  }
  throw new Error(`LawinServer-Daten nicht gefunden (gesucht in: ${candidates.join(", ")})`);
}

/**
 * Legt den Daten-Ordner an und kopiert jede mitgelieferte Standard-Datei der beschreibbaren Pfade,
 * die dort noch fehlt. Vorhandene Dateien werden nie überschrieben (der Spind bleibt erhalten,
 * neue Standard-Dateien späterer Versionen kommen trotzdem dazu).
 * @returns die kopierten Pfade (relativ zum Daten-Ordner)
 */
export function prepareDataDir(resourceDir: string, dataDir: string, writable: readonly string[]): string[] {
  const copied: string[] = [];
  fs.mkdirSync(dataDir, { recursive: true });

  const copyMissing = (rel: string): void => {
    const source = path.join(resourceDir, rel);
    const target = path.join(dataDir, rel);
    if (!fs.existsSync(source)) return;

    if (fs.statSync(source).isDirectory()) {
      fs.mkdirSync(target, { recursive: true });
      for (const name of fs.readdirSync(source)) copyMissing(path.join(rel, name));
    } else if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      copied.push(rel);
    }
  };

  for (const entry of writable) {
    if (entry.endsWith("/")) fs.mkdirSync(path.join(dataDir, entry), { recursive: true });
    copyMissing(entry.replace(/\/$/, ""));
  }

  return copied;
}
