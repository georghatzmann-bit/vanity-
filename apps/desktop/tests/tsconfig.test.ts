// @vitest-environment node
/**
 * WebView-Code (src/, ohne Tests) darf keine Node-Globals sehen: `Buffer`, `process`,
 * `require` & Co. gibt es in WebView2 nicht – mit Node-Typen würde solcher Code die
 * Typprüfung bestehen und erst zur Laufzeit abstürzen. Geprüft wird jede tsconfig, mit der
 * `pnpm typecheck` die App-Quellen prüft, mit einer eingeschobenen Probedatei.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const normalize = (path: string): string => path.replaceAll('\\', '/');

/** Die tsconfig-Dateien aus dem typecheck-Skript (`tsc -p <datei>`). */
function typecheckProjects(): string[] {
  const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const script = pkg.scripts?.['typecheck'] ?? '';
  return [...script.matchAll(/\btsc\s+(?:-p|--project)\s+(\S+)/g)].map((match) =>
    join(appDir, match[1] ?? ''),
  );
}

function parseProject(configPath: string): ts.ParsedCommandLine {
  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  if (error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  }
  return ts.parseJsonConfigFileContent(config, ts.sys, dirname(configPath));
}

/** Projekte, die die eigentliche WebView-Quelle (src/main.tsx) prüfen. */
function webviewProjects(): { configPath: string; parsed: ts.ParsedCommandLine }[] {
  const entry = normalize(join(appDir, 'src', 'main.tsx'));
  return typecheckProjects()
    .map((configPath) => ({ configPath, parsed: parseProject(configPath) }))
    .filter(({ parsed }) => parsed.fileNames.map(normalize).includes(entry));
}

/** Nur in Node vorhandene Globals – jede Zeile muss in der WebView-Prüfung scheitern. */
const NODE_ONLY_LINES = [
  "export const a = Buffer.from('x');",
  'export const b = process.cwd();',
  "export const c = require('node:fs');",
  'export const d = __dirname;',
  'export const e = global;',
];

/** Typfehler der Probedatei (eine pro Zeile erwartet) und aller übrigen Dateien. */
function checkWithProbe(parsed: ts.ParsedCommandLine) {
  const probePath = normalize(join(appDir, 'src', '__node_globals_probe__.ts'));
  const probeText = NODE_ONLY_LINES.join('\n');
  const host = ts.createCompilerHost(parsed.options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    normalize(fileName) === probePath
      ? ts.createSourceFile(fileName, probeText, languageVersion, true)
      : getSourceFile(fileName, languageVersion, ...rest);
  host.fileExists = (fileName) => normalize(fileName) === probePath || fileExists(fileName);
  host.readFile = (fileName) =>
    normalize(fileName) === probePath ? probeText : readFile(fileName);

  const program = ts.createProgram({
    rootNames: [...parsed.fileNames, probePath],
    options: parsed.options,
    host,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const probeLines = new Set<number>();
  const others: string[] = [];
  for (const diagnostic of diagnostics) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    if (diagnostic.file !== undefined && normalize(diagnostic.file.fileName) === probePath) {
      const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      probeLines.add(line);
    } else {
      others.push(`${diagnostic.file?.fileName ?? '?'}: ${message}`);
    }
  }
  return { probeLines, others };
}

describe('tsconfig: WebView-Code ohne Node-Typen', () => {
  it('pnpm typecheck prüft die App-Quellen mit eigener Konfiguration', () => {
    const projects = webviewProjects();
    expect(projects.length).toBeGreaterThan(0);
    for (const { parsed } of projects) {
      // Tests laufen in Node/jsdom und gehören in die Node-Konfiguration.
      expect(parsed.fileNames.filter((file) => /\.test\.tsx?$/.test(file))).toEqual([]);
      expect(parsed.options.types ?? []).not.toContain('node');
    }
  });

  it('Node-Globals (Buffer, process, require …) bestehen die Typprüfung von src/ nicht', () => {
    for (const { configPath, parsed } of webviewProjects()) {
      const { probeLines, others } = checkWithProbe(parsed);
      // Die echte App-Quelle bleibt fehlerfrei …
      expect(others, configPath).toEqual([]);
      // … jede Node-Zeile der Probe dagegen scheitert.
      expect(
        [...probeLines].sort((x, y) => x - y),
        configPath,
      ).toEqual(NODE_ONLY_LINES.map((_, index) => index));
    }
  }, 60_000);
});
