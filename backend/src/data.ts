// Find the resource folder and fill the data folder on the first start.
import fs from "node:fs";
import path from "node:path";

/**
 * Folder with the bundled LawinServer data (profiles/, responses/, CloudStorage/, Config/, public/).
 * When built it is next to dist/main.js; when running from the source (src/) it is ../lawinserver.
 * Relative to the program file on purpose, not to the working folder.
 */
export function findResourceDir(baseDir: string): string {
  const candidates = [baseDir, path.join(baseDir, "..", "lawinserver")];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "profiles")) && fs.existsSync(path.join(dir, "responses"))) return dir;
  }
  throw new Error(`LawinServer data not found (looked in: ${candidates.join(", ")})`);
}

/**
 * Creates the data folder and copies every bundled default file of the writable paths that is
 * still missing there. Existing files are never overwritten (the locker stays, new default files
 * of later versions are still added).
 * @returns the copied paths (relative to the data folder)
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
