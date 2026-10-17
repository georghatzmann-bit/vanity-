'use strict';
// Entry point. The same executable runs in two modes:
//   Phoenix.exe              -> UI (non-elevated)
//   Phoenix.exe --worker ... -> elevated install worker (see install/worker.js)
if (process.argv.includes('--worker')) {
  require('./install/worker').run();
} else {
  require('./ui').start();
}
