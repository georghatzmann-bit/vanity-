'use strict';
// Registry reads via PowerShell (UTF-8 safe, unlike reg.exe which prints in the OEM code page).
const { runPsJson } = require('./ps');

const HIVES = {
  HKCU: 'HKEY_CURRENT_USER',
  HKLM: 'HKEY_LOCAL_MACHINE',
  HKCR: 'HKEY_CLASSES_ROOT',
};

function toPsPath(key) {
  const [hive, ...rest] = String(key).split('\\');
  const full = HIVES[hive.toUpperCase()] || hive;
  return `Registry::${full}\\${rest.join('\\')}`;
}

const VALUE_PS = `
$p = $args[0]; $n = $args[1]
$v = $null
try { $v = (Get-ItemProperty -LiteralPath $p -Name $n -ErrorAction Stop).$n } catch { $v = $null }
Write-PhxJson @{ value = $v }
`;

const EXISTS_PS = `
$out = @()
foreach ($p in $args) { $out += [bool](Test-Path -LiteralPath $p) }
Write-PhxJson @($out)
`;

/** Reads one registry value as string, or null. Never throws. */
async function regQueryValue(key, name) {
  if (process.platform !== 'win32') return null;
  try {
    const res = await runPsJson(VALUE_PS, { args: [toPsPath(key), name], timeoutMs: 15000 });
    return res && res.value != null ? String(res.value) : null;
  } catch {
    return null;
  }
}

/** For each key: does it exist? Returns booleans in the same order. Never throws. */
async function regKeysExist(keys) {
  if (process.platform !== 'win32' || !keys.length) return keys.map(() => false);
  try {
    const res = await runPsJson(EXISTS_PS, { args: keys.map(toPsPath), timeoutMs: 15000 });
    return keys.map((_, i) => !!(Array.isArray(res) ? res[i] : res));
  } catch {
    return keys.map(() => false);
  }
}

module.exports = { regQueryValue, regKeysExist, toPsPath };
