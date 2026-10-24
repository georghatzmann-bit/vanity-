// Baut dist/: main.js (eine Datei, alle npm-Pakete eingebaut) + die Daten von LawinServer daneben.
// Aufruf über `pnpm build` (prüft vorher die Typen mit tsc).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lawin = path.join(root, "lawinserver");
const dist = path.join(root, "dist");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

// Alles, was LawinServer zur Laufzeit liest. Beschreibbares davon (profiles/, Config/, …) wird beim
// ersten Start in den Daten-Ordner kopiert, siehe lawinserver/structure/vanity.js (WRITABLE).
const DATA_DIRS = ["CloudStorage", "Config", "profiles", "public", "responses"];

fs.rmSync(dist, { recursive: true, force: true });

const result = await build({
  entryPoints: [path.join(root, "src", "main.ts")],
  outfile: path.join(dist, "main.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  // optionale, native Beschleuniger von ws – ws läuft ohne sie
  external: ["bufferutil", "utf-8-validate"],
  define: { __VANITY_VERSION__: JSON.stringify(pkg.version) },
  banner: {
    js: `// Vanity Backend ${pkg.version} – enthält LawinServer von Lawin0129 (GPL-3.0), siehe LICENSE und THIRD_PARTY_LICENSES.txt`,
  },
  legalComments: "eof",
  // express/lib/view.js lädt Template-Engines dynamisch; LawinServer nutzt keine.
  logOverride: { "unsupported-require-call": "silent" },
  metafile: true,
  logLevel: "warning",
});

for (const dir of DATA_DIRS) {
  fs.cpSync(path.join(lawin, dir), path.join(dist, dir), { recursive: true });
}

// Sorgt dafür, dass main.js auch dann als CommonJS läuft, wenn ein übergeordneter Ordner
// eine package.json mit "type": "module" hat.
fs.writeFileSync(path.join(dist, "package.json"), `${JSON.stringify({ private: true, type: "commonjs" }, null, 2)}\n`);

// Lizenzen: Vanity und LawinServer stehen unter GPL-3.0; dazu die Lizenztexte aller eingebauten npm-Pakete.
fs.copyFileSync(path.join(lawin, "LICENSE"), path.join(dist, "LICENSE"));

const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = /^(.*node_modules\/)((?:@[^/]+\/)?[^/]+)\//.exec(input.replace(/\\/g, "/"));
  if (!match) continue;
  const dir = path.resolve(root, match[1] + match[2]);
  if (packages.has(dir)) continue;
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const licenseFile = fs.readdirSync(dir).find((name) => /^(licen[cs]e|copying)(\.|$)/i.test(name));
  packages.set(dir, {
    id: `${meta.name}@${meta.version}`,
    license: typeof meta.license === "string" ? meta.license : "siehe Text",
    text: licenseFile ? fs.readFileSync(path.join(dir, licenseFile), "utf8").trim() : "(kein Lizenztext im Paket enthalten)",
  });
}

const sections = [...packages.values()]
  .sort((a, b) => a.id.localeCompare(b.id))
  .map((p) => `${"=".repeat(78)}\n${p.id} (${p.license})\n${"=".repeat(78)}\n${p.text}\n`);

fs.writeFileSync(
  path.join(dist, "THIRD_PARTY_LICENSES.txt"),
  [
    `Vanity Backend ${pkg.version}`,
    "",
    "Enthält LawinServer (https://github.com/Lawin0129/LawinServer) von Lawin0129 und",
    "PRO100KatYT, lizenziert unter der GNU General Public License v3.0 (siehe LICENSE).",
    "Die Daten in profiles/, responses/, CloudStorage/, Config/ und public/ stammen aus LawinServer.",
    "",
    "In main.js sind außerdem diese npm-Pakete eingebaut:",
    "",
    ...sections,
  ].join("\n"),
);

const size = (fs.statSync(path.join(dist, "main.js")).size / 1024).toFixed(0);
console.log(`dist/main.js (${size} KiB), ${packages.size} npm-Pakete eingebaut, Daten: ${DATA_DIRS.join(", ")}`);
