// @vitest-environment node
/**
 * Wächter für die CI-Workflows (.github/workflows), die den Windows-Installer der App bauen.
 *
 * - Lieferkette: Jede Action ist auf einen vollen Commit-SHA gepinnt (Tags/Branches sind
 *   veränderlich) und läuft auf Node 24; Checkout ohne gespeicherte Zugangsdaten.
 * - Reproduzierbarkeit: Jeder Cargo-Aufruf und `tauri build` laufen mit `--locked`.
 * - Goldene Regel: Clippy (mit den Sperren aus clippy.toml) sieht auch Release-Code
 *   (`cfg(not(debug_assertions))`) und Code hinter Features – je Ziel-Plattform.
 * - Hygiene: Timeouts je Job, fehlendes Installer-Artefakt bricht ab, Advisory-/Lizenz-Gate.
 *
 * Der Parser versteht nur die hier verwendete YAML-Teilmenge (Blockstil, `run: |`).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repoRoot = new URL('../../../', import.meta.url);
const workflowsDir = new URL('.github/workflows/', repoRoot);

interface Step {
  name?: string;
  uses?: string;
  usesComment?: string;
  run?: string;
  if?: string;
  shell?: string;
  with: Record<string, string>;
}

interface Job {
  id: string;
  timeoutMinutes?: number;
  steps: Step[];
}

interface Workflow {
  file: string;
  text: string;
  jobs: Job[];
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^(['"]).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function stripComment(value: string): string {
  return value.replace(/\s+#.*$/, '').trim();
}

/** Liest Jobs und Schritte eines Workflows (Einrückung: Jobs 2, Job-Schlüssel 4, Schritte 6). */
function parseWorkflow(file: string, text: string): Workflow {
  const jobs: Job[] = [];
  let inJobs = false;
  let job: Job | undefined;
  let step: Step | undefined;
  let block: { key: 'run' | 'with'; indent: number } | undefined;

  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    const indent = raw.length - raw.trimStart().length;
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    if (block !== undefined && step !== undefined && indent > block.indent) {
      if (block.key === 'run') {
        step.run = step.run === undefined || step.run === '' ? trimmed : `${step.run}\n${trimmed}`;
      } else {
        const entry = /^([\w-]+):\s*(.*)$/.exec(trimmed);
        if (entry?.[1] !== undefined) {
          step.with[entry[1]] = unquote(stripComment(entry[2] ?? ''));
        }
      }
      continue;
    }
    block = undefined;
    if (indent === 0) {
      inJobs = trimmed === 'jobs:';
      job = undefined;
      step = undefined;
      continue;
    }
    if (!inJobs) {
      continue;
    }
    if (indent === 2) {
      const id = /^([\w-]+):$/.exec(trimmed)?.[1];
      job = id === undefined ? undefined : { id, steps: [] };
      if (job !== undefined) {
        jobs.push(job);
      }
      step = undefined;
      continue;
    }
    if (job === undefined) {
      continue;
    }
    if (indent === 4) {
      step = undefined;
      const minutes = /^timeout-minutes:\s*(\d+)\s*$/.exec(trimmed)?.[1];
      if (minutes !== undefined) {
        job.timeoutMinutes = Number(minutes);
      }
      continue;
    }
    let content = trimmed;
    let keyIndent = indent;
    if (content.startsWith('- ')) {
      step = { with: {} };
      job.steps.push(step);
      content = content.slice(2).trimStart();
      keyIndent = indent + 2;
    }
    if (step === undefined) {
      continue;
    }
    const pair = /^([\w-]+):\s*(.*)$/.exec(content);
    const key = pair?.[1];
    const value = pair?.[2] ?? '';
    if (key === 'run') {
      if (/^[|>][-+]?$/.test(value.trim())) {
        step.run = '';
        block = { key: 'run', indent: keyIndent };
      } else {
        step.run = unquote(value);
      }
    } else if (key === 'with') {
      block = { key: 'with', indent: keyIndent };
    } else if (key === 'uses') {
      const hash = value.indexOf(' #');
      step.uses = (hash === -1 ? value : value.slice(0, hash)).trim();
      step.usesComment = hash === -1 ? '' : value.slice(hash + 2).trim();
    } else if (key === 'name' || key === 'if' || key === 'shell') {
      step[key] = unquote(stripComment(value));
    }
  }
  return { file, text, jobs };
}

function workflows(): Workflow[] {
  return readdirSync(workflowsDir)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .map((file) => parseWorkflow(file, readFileSync(new URL(file, workflowsDir), 'utf8')));
}

/** Logische Befehlszeilen eines `run` (Fortsetzungen mit `\` zusammengefügt). */
function commands(run: string): string[] {
  return run
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .flatMap((line) => line.split(/\s*&&\s*/))
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function allCommands(job: Job): string[] {
  return job.steps.flatMap((step) => (step.run === undefined ? [] : commands(step.run)));
}

/** Cargo-Unterbefehle, die Abhängigkeiten auflösen und daher `--locked` brauchen. */
const RESOLVING_CARGO = /\bcargo\s+(build|check|clippy|test|run|doc|bench|deny|metadata|tree)\b/;

/** Erste Version, die auf Node 24 läuft (laut action.yml der jeweiligen Version). */
const MIN_NODE24_VERSION: Readonly<Record<string, readonly [number, number]>> = {
  'actions/checkout': [5, 0],
  'actions/setup-node': [5, 0],
  'actions/upload-artifact': [6, 0],
  'pnpm/action-setup': [5, 0],
  'Swatinem/rust-cache': [2, 9],
};

function versionOf(comment: string): [number, number] | undefined {
  const match = /\bv?(\d+)\.(\d+)(?:\.\d+)?\b/.exec(comment);
  return match === null ? undefined : [Number(match[1]), Number(match[2])];
}

function clippyTarget(command: string): string {
  return /--target[\s=](\S+)/.exec(command)?.[1] ?? 'host';
}

const all = workflows();
const ci = all.find((workflow) => workflow.file === 'ci.yml');

describe('CI-Workflows: Lieferkette', () => {
  it('werden gefunden und geparst', () => {
    expect(ci).toBeDefined();
    for (const workflow of all) {
      expect(workflow.jobs.length, workflow.file).toBeGreaterThan(0);
      for (const job of workflow.jobs) {
        expect(job.steps.length, `${workflow.file}/${job.id}`).toBeGreaterThan(0);
      }
    }
  });

  it('pinnen jede Action auf einen vollen Commit-SHA mit Versionskommentar', () => {
    for (const workflow of all) {
      // Auch `uses:` außerhalb der erkannten Schritte zählt (Sicherheitsnetz für den Parser).
      const usesLines = [...workflow.text.matchAll(/^\s*(?:-\s+)?uses:\s*(.+)$/gm)].length;
      const steps = workflow.jobs.flatMap((job) => job.steps).filter((step) => step.uses);
      expect(steps.length, workflow.file).toBe(usesLines);
      for (const step of steps) {
        const where = `${workflow.file}: ${step.uses ?? ''}`;
        expect(step.uses, where).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
        expect(step.usesComment, `${where} – Version als Kommentar`).toMatch(/\S/);
      }
    }
  });

  it('verwenden Node-24-Versionen der JavaScript-Actions', () => {
    for (const workflow of all) {
      for (const step of workflow.jobs.flatMap((job) => job.steps)) {
        const action = step.uses?.split('@')[0] ?? '';
        const minimum = MIN_NODE24_VERSION[action];
        if (minimum === undefined) {
          continue;
        }
        const version = versionOf(step.usesComment ?? '');
        const where = `${workflow.file}: ${action} # ${step.usesComment ?? ''}`;
        expect(version, where).toBeDefined();
        const [major, minor] = version ?? [0, 0];
        expect(major > minimum[0] || (major === minimum[0] && minor >= minimum[1]), where).toBe(
          true,
        );
      }
    }
  });

  it('checken ohne gespeicherte Zugangsdaten aus (persist-credentials: false)', () => {
    for (const workflow of all) {
      for (const step of workflow.jobs.flatMap((job) => job.steps)) {
        if (step.uses?.startsWith('actions/checkout@') === true) {
          expect(step.with['persist-credentials'], workflow.file).toBe('false');
        }
      }
    }
  });

  it('laden Werkzeuge nur mit geprüfter SHA-256-Prüfsumme herunter', () => {
    for (const workflow of all) {
      for (const job of workflow.jobs) {
        for (const step of job.steps) {
          if (step.run !== undefined && /\bcurl\b|\bwget\b/.test(step.run)) {
            expect(step.run, `${workflow.file}/${job.id}`).toMatch(/sha256sum --check --strict/);
          }
        }
      }
    }
  });
});

describe('CI-Workflows: Reproduzierbarkeit und Hygiene', () => {
  it('setzen für jeden Job ein Timeout', () => {
    for (const workflow of all) {
      for (const job of workflow.jobs) {
        const where = `${workflow.file}/${job.id}`;
        expect(job.timeoutMinutes, where).toBeDefined();
        expect(job.timeoutMinutes ?? 0, where).toBeGreaterThan(0);
        expect(job.timeoutMinutes ?? 0, where).toBeLessThanOrEqual(90);
      }
    }
  });

  it('rufen Cargo und tauri build nur mit --locked auf (Cargo.lock wie eingecheckt)', () => {
    let cargoCalls = 0;
    for (const workflow of all) {
      for (const job of workflow.jobs) {
        for (const command of allCommands(job)) {
          if (RESOLVING_CARGO.test(command)) {
            cargoCalls += 1;
            expect(command, `${workflow.file}/${job.id}`).toMatch(/(?:^|\s)--locked(?:\s|$)/);
          }
          if (/\btauri\s+build\b/.test(command)) {
            cargoCalls += 1;
            // Argumente nach `--` reicht die Tauri-CLI an `cargo build` weiter.
            expect(command, `${workflow.file}/${job.id}`).toMatch(/\s--\s+(?:\S+\s+)*--locked\b/);
          }
        }
      }
    }
    expect(cargoCalls).toBeGreaterThan(0);
  });

  it('brechen ab, wenn das Installer-Artefakt fehlt', () => {
    const uploads = (ci?.jobs ?? [])
      .flatMap((job) => job.steps)
      .filter((step) => step.uses?.startsWith('actions/upload-artifact@') === true);
    const installer = uploads.filter((step) => step.with['name'] === 'aegis-windows-nsis');
    expect(installer).toHaveLength(1);
    for (const step of uploads.filter((upload) => upload.if === undefined)) {
      expect(step.with['if-no-files-found'], step.with['name']).toBe('error');
    }
  });

  it('bereiten das Aufräumen von rust-cache vor (sonst ##[error] ENOENT bei jedem Lauf)', () => {
    for (const workflow of all) {
      for (const job of workflow.jobs) {
        if (!job.steps.some((step) => step.uses?.startsWith('Swatinem/rust-cache@') === true)) {
          continue;
        }
        const last = job.steps.at(-1);
        expect(last?.if, `${workflow.file}/${job.id}`).toBe('always()');
        expect(last?.run, `${workflow.file}/${job.id}`).toMatch(
          /mkdir -p target\/tests\/target target\/tests\/trybuild/,
        );
      }
    }
  });
});

describe('Clippy sieht Debug- und Release-Code mit allen Features', () => {
  function expectFullCoverage(where: string, clippyCommands: string[]): void {
    expect(clippyCommands.length, where).toBeGreaterThan(0);
    for (const target of new Set(clippyCommands.map(clippyTarget))) {
      const forTarget = clippyCommands.filter((command) => clippyTarget(command) === target);
      const label = `${where} (${target})`;
      for (const command of forTarget) {
        expect(command, label).toMatch(/--all-targets/);
        expect(command, label).toMatch(/--\s+(?:\S+\s+)*-D warnings/);
      }
      // cfg(debug_assertions)-Code: Debug-Profil.
      expect(
        forTarget.some((command) => !/--release\b/.test(command)),
        `${label}: Clippy im Debug-Profil`,
      ).toBe(true);
      // cfg(not(debug_assertions)) und optionale Features: Release-Profil mit allen Features.
      expect(
        forTarget.some(
          (command) => /--release\b/.test(command) && /--all-features\b/.test(command),
        ),
        `${label}: Clippy mit --release --all-features`,
      ).toBe(true);
    }
  }

  it('in jedem CI-Job mit Clippy, je Ziel-Plattform', () => {
    const jobs = (ci?.jobs ?? []).filter((job) =>
      allCommands(job).some((command) => /\bcargo\s+clippy\b/.test(command)),
    );
    expect(jobs.map((job) => job.id).sort()).toEqual(['rust-linux', 'windows']);
    for (const job of jobs) {
      const clippy = allCommands(job).filter((command) => /\bcargo\s+clippy\b/.test(command));
      expectFullCoverage(`ci.yml/${job.id}`, clippy);
    }
    // Der Linux-Job prüft zusätzlich gegen das Windows-Ziel (cfg(windows)-Code).
    const linux = jobs.find((job) => job.id === 'rust-linux');
    expect(allCommands(linux ?? { id: '', steps: [] }).map(clippyTarget)).toContain(
      'x86_64-pc-windows-msvc',
    );
  });

  it('in den lokalen Skripten rust:check und rust:check:windows', () => {
    const pkg = JSON.parse(readFileSync(new URL('package.json', repoRoot), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const name of ['rust:check', 'rust:check:windows']) {
      const script = pkg.scripts[name] ?? '';
      const clippy = commands(script).filter((command) => /\bcargo\s+clippy\b/.test(command));
      expectFullCoverage(`package.json ${name}`, clippy);
      for (const command of commands(script).filter((line) => RESOLVING_CARGO.test(line))) {
        expect(command, name).toMatch(/(?:^|\s)--locked(?:\s|$)/);
      }
    }
  });
});

describe('Advisory- und Lizenz-Gate', () => {
  const supplyChain = all.find((workflow) => workflow.file === 'supply-chain.yml');
  const denyConfig = new URL('supply-chain.deny.toml', workflowsDir);

  it('läuft bei Push, Pull-Request und wöchentlich', () => {
    expect(supplyChain).toBeDefined();
    const text = supplyChain?.text ?? '';
    expect(text).toMatch(/^on:\s*$/m);
    expect(text).toMatch(/^ {2}push:/m);
    expect(text).toMatch(/^ {2}pull_request:/m);
    expect(text).toMatch(/^ {2}schedule:\s*\n\s+- cron: '[^']+'/m);
  });

  it('prüft Rust (cargo deny) und npm (pnpm audit)', () => {
    const run = (supplyChain?.jobs ?? []).flatMap(allCommands);
    const deny = run.find((command) => /\bcargo\s+deny\b/.test(command)) ?? '';
    expect(deny).toMatch(/--config \.github\/workflows\/supply-chain\.deny\.toml/);
    expect(deny).toMatch(/\bcheck advisories bans licenses sources\b/);
    expect(run).toContain('pnpm audit --prod --audit-level high');
  });

  it('bewertet den Windows-Build und verbietet GPL-Lizenzen (ClamAV nur als Prozess)', () => {
    expect(existsSync(denyConfig)).toBe(true);
    const toml = readFileSync(denyConfig, 'utf8');
    expect(toml).toMatch(/^targets = \["x86_64-pc-windows-msvc"\]$/m);
    const allow = /^allow = \[([\s\S]*?)\]/m.exec(toml)?.[1] ?? '';
    const licenses = [...allow.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '');
    expect(licenses.length).toBeGreaterThan(0);
    for (const license of licenses) {
      expect(license).not.toMatch(/GPL/i);
    }
    expect(toml).toMatch(/^unknown-registry = "deny"$/m);
    expect(toml).toMatch(/^unknown-git = "deny"$/m);
  });
});
