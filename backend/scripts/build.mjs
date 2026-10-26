// Builds dist/: main.js (one file with every npm package built in) + LawinServer's data next to it.
// Run via `pnpm build` (checks the types with tsc first).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lawin = path.join(root, "lawinserver");
const dist = path.join(root, "dist");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

// Everything LawinServer reads while running. The writable part (profiles/, Config/, …) is copied into
// the data folder on the first start, see lawinserver/structure/niobium.js (WRITABLE).
const DATA_DIRS = ["CloudStorage", "Config", "profiles", "public", "responses"];

fs.rmSync(dist, { recursive: true, force: true });

const result = await build({
  entryPoints: [path.join(root, "src", "main.ts")],
  outfile: path.join(dist, "main.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  // optional native speed-ups of ws – ws runs without them
  external: ["bufferutil", "utf-8-validate"],
  define: { __NIOBIUM_VERSION__: JSON.stringify(pkg.version) },
  banner: {
    js: `// Niobium Backend ${pkg.version} – contains LawinServer by Lawin0129 (GPL-3.0), see LICENSE and THIRD_PARTY_LICENSES.txt`,
  },
  legalComments: "eof",
  // express/lib/view.js loads template engines dynamically; LawinServer uses none.
  logOverride: { "unsupported-require-call": "silent" },
  metafile: true,
  logLevel: "warning",
});

for (const dir of DATA_DIRS) {
  fs.cpSync(path.join(lawin, dir), path.join(dist, dir), { recursive: true });
}

// Makes sure main.js runs as CommonJS even if a parent folder has a package.json
// with "type": "module".
fs.writeFileSync(path.join(dist, "package.json"), `${JSON.stringify({ private: true, type: "commonjs" }, null, 2)}\n`);

// Licences: Niobium and LawinServer are GPL-3.0; plus the licence texts of every built-in npm package.
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
    license: typeof meta.license === "string" ? meta.license : "see text",
    text: licenseFile ? fs.readFileSync(path.join(dir, licenseFile), "utf8").trim() : "(no licence text in the package)",
  });
}

const sections = [...packages.values()]
  .sort((a, b) => a.id.localeCompare(b.id))
  .map((p) => `${"=".repeat(78)}\n${p.id} (${p.license})\n${"=".repeat(78)}\n${p.text}\n`);

fs.writeFileSync(
  path.join(dist, "THIRD_PARTY_LICENSES.txt"),
  [
    `Niobium Backend ${pkg.version}`,
    "",
    "Contains LawinServer (https://github.com/Lawin0129/LawinServer) by Lawin0129 and",
    "PRO100KatYT, licensed under the GNU General Public License v3.0 (see LICENSE).",
    "The data in profiles/, responses/, CloudStorage/, Config/ and public/ comes from LawinServer.",
    "",
    "main.js also has these npm packages built in:",
    "",
    ...sections,
  ].join("\n"),
);

const size = (fs.statSync(path.join(dist, "main.js")).size / 1024).toFixed(0);
console.log(`dist/main.js (${size} KiB), ${packages.size} npm packages built in, data: ${DATA_DIRS.join(", ")}`);
