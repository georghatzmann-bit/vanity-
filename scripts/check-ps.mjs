// Dev check: parses every embedded PowerShell script (and Ensure-Winget.ps1) with a real PowerShell parser.
// Usage: PWSH=/path/to/pwsh node scripts/check-ps.mjs   (CI on Windows: PWSH=powershell.exe, i.e. 5.1)
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src/main/', import.meta.url)); // (.pathname is '/D:/...' on Windows)
const pwsh = process.env.PWSH || 'pwsh';
const psSrc = readFileSync(join(root, 'util/ps.js'), 'utf8');
const JSON_MARK = '@@PHXJSON@@';
// eslint-disable-next-line no-eval
const preamble = eval(psSrc.match(/const PREAMBLE = (\[[\s\S]*?\])\.join/)[1]).join('\r\n');

const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
};
walk(root);

const scripts = [];
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/const (\w+_PS) = `([\s\S]*?)`;/g)) {
    // eslint-disable-next-line no-eval
    scripts.push({ name: `${f.replace(root, '')}:${m[1]}`, body: preamble + eval('`' + m[2] + '`') });
  }
}
scripts.push({ name: 'winget/Ensure-Winget.ps1', body: readFileSync(join(root, 'winget/Ensure-Winget.ps1'), 'utf8') });

const dir = mkdtempSync(join(tmpdir(), 'pscheck-'));
let failed = 0;
for (const s of scripts) {
  if (/[^\x00-\x7F]/.test(s.body.replace(preamble, ''))) {
    console.log(`FAIL ${s.name}: non-ASCII characters`);
    failed++;
    continue;
  }
  const file = join(dir, 'x.ps1');
  writeFileSync(file, s.body, 'ascii');
  const cmd = `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$null, [ref]$e); if ($e) { $e | ForEach-Object { $_.Extent.StartLineNumber.ToString() + ': ' + $_.Message }; exit 1 }`;
  try {
    execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', cmd], { stdio: 'pipe' });
    console.log(`ok   ${s.name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${s.name}\n${String(err.stdout)}`);
  }
}
process.exit(failed ? 1 : 0);
