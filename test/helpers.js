'use strict';
// Baut für Tests einen nachgemachten %LOCALAPPDATA%-Ordner mit Fortnite-Einstellungen.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GUS_MAIN = [
  '[/Script/FortniteGame.FortGameUserSettings]',
  'bUseVSync=False',
  'bUseDynamicResolution=False',
  'ResolutionSizeX=1920',
  'ResolutionSizeY=1080',
  'LastUserConfirmedResolutionSizeX=1920',
  'LastUserConfirmedResolutionSizeY=1080',
  'FullscreenMode=0',
  'LastConfirmedFullscreenMode=0',
  'PreferredFullscreenMode=0',
  'FrameRateLimit=240.000000',
  'DisplayGamma=2.200000',
  'bShowGrass=False',
  'bMotionBlur=False',
  'bDisableMouseAcceleration=True',
  '',
  '[ScalabilityGroups]',
  'sg.ResolutionQuality=100.000000',
  'sg.ViewDistanceQuality=2',
  'sg.AntiAliasingQuality=0',
  'sg.ShadowQuality=0',
  'sg.GlobalIlluminationQuality=0',
  'sg.ReflectionQuality=0',
  'sg.PostProcessQuality=0',
  'sg.TextureQuality=1',
  'sg.EffectsQuality=0',
  'sg.FoliageQuality=0',
  'sg.ShadingQuality=0',
  '',
  '[D3DRHIPreference]',
  'PreferredRHI=dx11',
  'PreferredFeatureLevel=es31',
  '',
  '[PerformanceMode]',
  'MeshQuality=0',
  '',
].join('\r\n');

function makeLocalAppData({ withRememberMe = false, clientSettings = 'MAIN-KEYBINDS', extraEngine = true } = {}) {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'helix-local-'));
  const saved = path.join(local, 'FortniteGame', 'Saved');
  const wc = path.join(saved, 'Config', 'WindowsClient');
  fs.mkdirSync(wc, { recursive: true });
  let gus = GUS_MAIN;
  if (withRememberMe) gus += '\r\n[RememberMe]\r\nEnable=True\r\nData=' + 'A'.repeat(200) + '\r\n';
  fs.writeFileSync(path.join(wc, 'GameUserSettings.ini'), gus);
  // ClientSettings.Sav ist eine Binärdatei
  fs.writeFileSync(path.join(saved, 'Config', 'ClientSettings.Sav'), Buffer.concat([Buffer.from([0x47, 0x56, 0x41, 0x53, 0, 1, 2, 255]), Buffer.from(clientSettings)]));
  if (extraEngine) fs.writeFileSync(path.join(wc, 'Engine.ini'), '[SystemSettings]\r\nr.Tonemapper.Sharpen=1\r\n');
  fs.mkdirSync(path.join(saved, 'Config', 'CrashReportClient', 'UECC-Windows-ABC'), { recursive: true });
  fs.writeFileSync(path.join(saved, 'Config', 'CrashReportClient', 'UECC-Windows-ABC', 'CrashReportClient.ini'), '[CrashReportClient]\r\nbAgreeToCrashUpload=false\r\n');
  // Dinge, die nie in ein Profil dürfen
  fs.mkdirSync(path.join(saved, 'webcache_4430', 'Cookies'), { recursive: true });
  fs.writeFileSync(path.join(saved, 'webcache_4430', 'Cookies', 'Cookies'), 'secret-cookie');
  fs.mkdirSync(path.join(saved, 'Logs'), { recursive: true });
  fs.writeFileSync(path.join(saved, 'Logs', 'FortniteGame.log'), 'log');
  return { local, saved, config: path.join(saved, 'Config'), wc };
}

function tmpDir(prefix = 'helix-data-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Nachgemachtes tasklist/taskkill: runningRef.value = Liste laufender Programme */
function fakeExec(runningRef = { value: [] }) {
  const calls = [];
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    if (/tasklist/i.test(file)) {
      return runningRef.value.map((n, i) => `"${n}","${1000 + i}","Console","1","120.000 K"`).join('\r\n') + '\r\n';
    }
    if (/taskkill/i.test(file)) {
      const name = args[args.indexOf('/IM') + 1];
      runningRef.value = runningRef.value.filter((n) => n.toLowerCase() !== String(name).toLowerCase());
      return 'OK';
    }
    return '';
  };
  exec.calls = calls;
  return exec;
}

module.exports = { makeLocalAppData, tmpDir, fakeExec, GUS_MAIN };
