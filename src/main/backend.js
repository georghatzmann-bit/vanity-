'use strict';
// Real (Windows) backend. Must expose exactly the same functions as ./mock/index.js.
const hardware = require('./scan/hardware');
const locate = require('./winget/locate');
const bootstrap = require('./winget/bootstrap');
const scan = require('./scan');
const catalog = require('./catalog');
const profile = require('./profile/profile');
const code = require('./profile/code');
const paths = require('./util/paths');
const queue = require('./install/queue');
const games = require('./games/launch');

module.exports = {
  getMachineInfo: () => hardware.getMachineInfo(),
  getWingetStatus: () => locate.getStatus(),
  ensureWinget: (onProgress) => bootstrap.ensureWinget({ onProgress }),
  runScan: (onProgress) => scan.runScan({ onProgress }),
  getCatalog: () => catalog.getCatalog(),
  saveProfile: (p, dir, parentWin) => profile.saveProfile(p, { dir, parentWin }),
  saveToDrive: (p, root) => profile.saveToDrive(p, root),
  openProfileDialog: (parentWin) => profile.openProfileDialog(parentWin),
  findProfiles: () => profile.findProfiles(),
  loadProfile: (file) => profile.loadProfile(file),
  encodeProfile: (p) => code.encode(p),
  decodeProfile: (text) => code.decode(text),
  listDrives: () => paths.listTargets(),
  findSetupExe: () => paths.findSetupExe(),
  startInstall: (items, emit) => queue.startJob(items, { emit }),
  cancelInstall: () => queue.cancelJob(),
  detectLaunchers: () => games.detectLaunchers(),
  installGame: (game, mode) => games.installGame(game, mode),
};
