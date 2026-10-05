// =============================================================================
// BuildDuel - kleiner lokaler Server fuer Node.js (Ersatz, falls kein Python da ist)
// =============================================================================
// Macht dasselbe wie tools/server.py: richtige Datei-Typen, kein
// Zwischenspeichern, freien Port suchen (8000, 8001 ...), Browser oeffnen,
// nur auf diesem PC erreichbar (127.0.0.1). Braucht kein Internet und keine
// Zusatz-Pakete.
//
// Aufruf:  node tools/server.js [--port 8000] [--no-browser]
// Beenden: Fenster schliessen oder Strg + C
// =============================================================================
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT = path.resolve(__dirname, '..'); // Ordner BuildDuel
const HOST = '127.0.0.1';
const PORTS_TO_TRY = 11; // 8000 bis 8010

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

function parseArgs(argv) {
  const args = { port: 8000, browser: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-browser') args.browser = false;
    else if (argv[i] === '--port' && argv[i + 1]) args.port = parseInt(argv[++i], 10) || 8000;
  }
  return args;
}

function send(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Nicht erlaubt');

  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Ungueltige Adresse');
  }

  // Sicherheit: nur Dateien INNERHALB des Spiel-Ordners ausliefern
  let filePath = path.normalize(path.join(ROOT, urlPath));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) return send(res, 403, 'Verboten');

  fs.stat(filePath, (err, stats) => {
    if (!err && stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      return fs.stat(filePath, (err2, stats2) => serveFile(req, res, filePath, err2, stats2));
    }
    serveFile(req, res, filePath, err, stats);
  });
}

function serveFile(req, res, filePath, err, stats) {
  if (err || !stats.isFile()) {
    console.log(`  Hinweis: ${req.url} -> Fehler 404`);
    return send(res, 404, 'Datei nicht gefunden');
  }
  const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stats.size,
    'Cache-Control': 'no-store, must-revalidate',
  });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function openBrowser(url) {
  let command;
  if (process.platform === 'win32') command = `start "" "${url}"`;
  else if (process.platform === 'darwin') command = `open "${url}"`;
  else command = `xdg-open "${url}"`;
  exec(command, (error) => {
    if (error) console.log(`  Browser konnte nicht geoeffnet werden. Bitte selbst oeffnen: ${url}`);
  });
}

function listen(port, lastPort, onReady) {
  const server = http.createServer(handle);
  server.once('error', (error) => {
    if ((error.code === 'EADDRINUSE' || error.code === 'EACCES') && port < lastPort) {
      listen(port + 1, lastPort, onReady);
    } else {
      console.log(`FEHLER: Server konnte nicht starten (${error.code || error.message}).`);
      console.log('Schliesse andere Server-Fenster (z. B. ein zweites start.bat) und versuche es nochmal.');
      process.exitCode = 4;
    }
  });
  server.listen({ port, host: HOST }, () => onReady(server, port));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
    console.log(`FEHLER: index.html nicht gefunden in ${ROOT}`);
    console.log('Bitte den ganzen Ordner BuildDuel entpacken und start.bat darin starten.');
    process.exitCode = 2;
    return;
  }

  listen(args.port, args.port + PORTS_TO_TRY - 1, (server, port) => {
    const url = `http://localhost:${port}/`;
    console.log('');
    console.log(`  BuildDuel laeuft:  ${url}`);
    console.log(`  Tests:             ${url}tests/tests.html`);
    console.log('');
    if (port !== args.port) {
      console.log(`  Hinweis: Port ${args.port} war belegt, darum jetzt Port ${port}.`);
      console.log('  Gespeicherte Einstellungen gelten pro Adresse - am besten das andere');
      console.log(`  Programm auf Port ${args.port} schliessen und start.bat neu starten.`);
      console.log('');
    }
    console.log('  Dieses Fenster OFFEN lassen, solange du spielst.');
    console.log('  Beenden: Fenster schliessen oder Strg + C druecken.');
    console.log('');
    if (args.browser) openBrowser(url);

    process.on('SIGINT', () => {
      console.log('\n  Server beendet.');
      server.close();
      process.exit(0);
    });
  });
}

main();
