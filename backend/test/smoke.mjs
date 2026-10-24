// Smoke-Test für das gebaute Backend (dist/main.js).
// Startet den Server auf freien Ports mit einem leeren Temp-Daten-Ordner und spielt nach,
// was ein Fortnite-19.10-Client beim Login, im Spind und beim Matchmaking anfragt.
// Aufruf: pnpm build && pnpm test      (Exit-Code ≠ 0, wenn eine Prüfung fehlschlägt)
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = path.join(ROOT, "dist", "main.js");
const UA = "Fortnite/++Fortnite+Release-19.10-CL-18775446 Windows/10.0.22621.1.256.64bit";
const ACCOUNT = "georg";

if (!fs.existsSync(MAIN)) {
  console.error("dist/main.js fehlt – erst `pnpm build` ausführen.");
  process.exit(2);
}

// ---------------------------------------------------------------- Hilfen

const results = { ok: 0, fail: 0, skip: 0 };

async function check(name, fn) {
  try {
    await fn();
    results.ok++;
    console.log(`  OK    ${name}`);
  } catch (err) {
    results.fail++;
    console.log(`  FAIL  ${name}\n        ${err?.stack?.split("\n").slice(0, 3).join("\n        ") ?? err}`);
  }
}

function skip(name, reason) {
  results.skip++;
  console.log(`  SKIP  ${name} (${reason})`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function eq(actual, expected, what) {
  assert(actual === expected, `${what}: erwartet ${JSON.stringify(expected)}, bekommen ${JSON.stringify(actual)}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function request(method, url, { headers = {}, body, form } = {}) {
  return new Promise((resolve, reject) => {
    let payload;
    const h = { "User-Agent": UA, ...headers };
    if (form !== undefined) {
      payload = new URLSearchParams(form).toString();
      h["Content-Type"] = "application/x-www-form-urlencoded";
    } else if (body !== undefined) {
      payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      h["Content-Type"] ??= "application/json";
    }
    if (payload !== undefined) h["Content-Length"] = Buffer.byteLength(payload);

    const req = http.request(url, { method, headers: h, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString("utf8");
        resolve({
          status: res.statusCode,
          headers: res.headers,
          buf,
          text,
          json() {
            try {
              return JSON.parse(text);
            } catch {
              throw new Error(`keine JSON-Antwort (${res.statusCode}): ${text.slice(0, 200)}`);
            }
          },
        });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`Zeitüberschreitung: ${method} ${url}`)));
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function startServer(env, label) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vanity-cwd-")); // beliebiger Arbeitsordner
  const child = spawn(process.execPath, [MAIN], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = [];
  const collect = (stream) => {
    let rest = "";
    stream.setEncoding("utf8");
    stream.on("data", (d) => {
      rest += d;
      const parts = rest.split("\n");
      rest = parts.pop();
      lines.push(...parts.map((l) => l.replace(/\r$/, "")));
    });
  };
  collect(child.stdout);
  collect(child.stderr);

  let exited = null;
  child.on("exit", (code) => (exited = code));

  const base = `http://127.0.0.1:${env.VANITY_BACKEND_PORT}`;
  const deadline = Date.now() + 20000;
  const fail = (message) => {
    child.kill("SIGKILL");
    fs.rmSync(cwd, { recursive: true, force: true });
    throw new Error(`${label}: ${message}:\n${lines.join("\n")}`);
  };
  for (;;) {
    if (exited !== null) fail(`Server beendet (Code ${exited})`);
    try {
      const res = await request("GET", `${base}/vanity/health`);
      if (res.status === 200) break;
    } catch {}
    if (Date.now() > deadline) fail("/vanity/health antwortet nicht");
    await new Promise((r) => setTimeout(r, 100));
  }
  // XMPP/Matchmaker startet direkt nach dem HTTP-Port
  while (!lines.some((l) => l.includes("XMPP and Matchmaker"))) {
    if (Date.now() > deadline) fail("Matchmaker-Port startet nicht");
    await new Promise((r) => setTimeout(r, 50));
  }

  return {
    base,
    lines,
    async stop() {
      if (exited === null) {
        const done = new Promise((r) => child.on("exit", r));
        child.kill("SIGTERM");
        await done;
      }
      fs.rmSync(cwd, { recursive: true, force: true });
    },
  };
}

const mcp = (base, command, profileId, body = {}) =>
  request("POST", `${base}/fortnite/api/game/v2/profile/${ACCOUNT}/client/${command}?profileId=${profileId}&rvn=-1`, {
    body,
    headers: { Authorization: "bearer lawinstokenlol" },
  });

function sha1(file) {
  return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
}

function listFiles(dir) {
  return fs.readdirSync(dir, { recursive: true }).map((p) => p.replace(/\\/g, "/"));
}

// ---------------------------------------------------------------- Ablauf

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vanity-data-"));
const distAthena = path.join(ROOT, "dist", "profiles", "athena.json");
const distAthenaHash = sha1(distAthena);
const distFilesBefore = listFiles(path.join(ROOT, "dist")).length;
const servers = [];

try {
  const httpPort = await freePort();
  const mmPort = await freePort();
  const env = {
    VANITY_BACKEND_PORT: String(httpPort),
    VANITY_MATCHMAKER_PORT: String(mmPort),
    VANITY_BIND: "127.0.0.1",
    VANITY_DATA_DIR: dataDir,
    VANITY_GAMESERVER: "10.20.30.40:7778",
  };

  console.log(`\nServer 1: HTTP ${httpPort}, Matchmaker/XMPP ${mmPort}, Daten ${dataDir}`);
  const s1 = await startServer(env, "Server 1");
  servers.push(s1);
  const B = s1.base;

  await check("GET /vanity/health → { ok: true, version }", async () => {
    const res = await request("GET", `${B}/vanity/health`);
    eq(res.status, 200, "Status");
    const j = res.json();
    eq(j.ok, true, "ok");
    assert(typeof j.version === "string" && j.version.length > 0, "version fehlt");
  });

  await check("GET /vanity/status → alle Felder, gameServer aus VANITY_GAMESERVER", async () => {
    const j = (await request("GET", `${B}/vanity/status`)).json();
    for (const key of ["name", "hosting", "playlist", "players", "maxPlayers", "version", "gameServer"]) assert(key in j, `Feld ${key} fehlt`);
    eq(j.gameServer.ip, "10.20.30.40", "gameServer.ip");
    eq(j.gameServer.port, 7778, "gameServer.port");
  });

  await check("Daten-Ordner beim ersten Start befüllt", async () => {
    for (const rel of ["profiles/athena.json", "profiles/common_core.json", "Config/config.ini", "Config/catalog_config.json", "responses/friendslist.json", "responses/privacy.json", "responses/Athena/SeasonData.json"]) {
      assert(fs.existsSync(path.join(dataDir, rel)), `${rel} fehlt im Daten-Ordner`);
    }
    assert(fs.statSync(path.join(dataDir, "ClientSettings")).isDirectory(), "ClientSettings/ fehlt");
  });

  await check("POST /account/api/oauth/token (password, georg@vanity.local) → Name georg", async () => {
    const res = await request("POST", `${B}/account/api/oauth/token`, {
      form: { grant_type: "password", username: `${ACCOUNT}@vanity.local`, password: "vanity" },
      headers: { Authorization: "basic ZWM2ODRiOGM2ODdmNDc5ZmFkZWEzY2IyYWQ4M2Y1YzY6ZTFmMzFjMjExZjI4NDEzMTg2MjYyZDM3YTEzZmM4NGQ=" },
    });
    eq(res.status, 200, "Status");
    const j = res.json();
    eq(j.account_id, ACCOUNT, "account_id");
    eq(j.displayName, ACCOUNT, "displayName");
    assert(j.access_token, "access_token fehlt");
  });

  await check("GET /account/api/public/account/georg", async () => {
    const j = (await request("GET", `${B}/account/api/public/account/${ACCOUNT}`)).json();
    eq(j.id, ACCOUNT, "id");
    eq(j.displayName, ACCOUNT, "displayName");
  });

  await check("GET /fortnite/api/v2/versioncheck/Windows → NO_UPDATE", async () => {
    const res = await request("GET", `${B}/fortnite/api/v2/versioncheck/Windows?version=%2B%2BFortnite%2BRelease-19.10-CL-18775446-Windows`);
    eq(res.status, 200, "Status");
    eq(res.json().type, "NO_UPDATE", "type");
  });

  let athena;
  await check("QueryProfile athena (rvn=-1) → fullProfileUpdate, Season 19", async () => {
    const res = await mcp(B, "QueryProfile", "athena");
    eq(res.status, 200, "Status");
    const j = res.json();
    eq(j.profileId, "athena", "profileId");
    eq(j.profileChanges[0]?.changeType, "fullProfileUpdate", "changeType");
    athena = j.profileChanges[0].profile;
    eq(athena.stats.attributes.season_num, 19, "season_num");
    assert(Object.keys(athena.items).length > 1000, "zu wenige Items");
  });

  await check("QueryProfile common_core", async () => {
    const j = (await mcp(B, "QueryProfile", "common_core")).json();
    eq(j.profileId, "common_core", "profileId");
    eq(j.profileChanges[0]?.profile?.profileId, "common_core", "profile.profileId");
  });

  await check("weitere Login-/Lobby-Anfragen von 19.10 → keine Fehler", async () => {
    const calls = [
      ["GET", "/lightswitch/api/service/bulk/status"],
      ["GET", "/account/api/oauth/verify"],
      ["GET", "/fortnite/api/game/v2/enabled_features"],
      ["GET", "/fortnite/api/calendar/v1/timeline"],
      ["GET", "/fortnite/api/storefront/v2/catalog"],
      ["GET", "/fortnite/api/storefront/v2/keychain"],
      ["GET", `/friends/api/v1/${ACCOUNT}/summary`],
      ["GET", `/friends/api/public/friends/${ACCOUNT}`],
      ["GET", `/fortnite/api/game/v2/privacy/account/${ACCOUNT}`],
      ["POST", `/fortnite/api/game/v2/privacy/account/${ACCOUNT}`, { optOutOfPublicLeaderboards: true }],
      ["GET", `/party/api/v1/Fortnite/user/${ACCOUNT}`],
      ["GET", `/fortnite/api/receipts/v1/account/${ACCOUNT}/receipts`],
      ["GET", "/waitingroom/api/waitingroom"],
      ["GET", `/api/v1/events/Fortnite/download/${ACCOUNT}`],
      ["GET", "/content/api/pages/fortnite-game/spark-tracks"],
      ["POST", "/api/v1/fortnite-br/surfaces/motd/target", { language: "de", tags: ["Product.BR"] }],
      ["GET", "/fortnite/api/cloudstorage/system/DefaultRuntimeOptions.ini"],
      ["GET", "/images/lawin.jpg"],
      ["GET", "/region"],
      ["POST", `/fortnite/api/game/v2/profile/${ACCOUNT}/client/ClientQuestLogin?profileId=athena&rvn=-1`, {}],
      ["POST", `/fortnite/api/game/v2/profile/${ACCOUNT}/client/QueryProfile?profileId=common_public&rvn=-1`, {}],
      ["POST", `/fortnite/api/game/v2/profile/${ACCOUNT}/client/QueryProfile?profileId=creative&rvn=-1`, {}],
      ["POST", `/fortnite/api/game/v2/profile/${ACCOUNT}/client/QueryProfile?profileId=collections&rvn=-1`, {}],
      ["POST", `/fortnite/api/game/v2/profile/${ACCOUNT}/client/SetMtxPlatform?profileId=common_core&rvn=-1`, { newPlatform: "EpicPC" }],
    ];
    const bad = [];
    for (const [method, url, body] of calls) {
      const res = await request(method, `${B}${url}`, { body });
      if (res.status >= 400) bad.push(`${method} ${url} → ${res.status}`);
    }
    assert(bad.length === 0, bad.join("; "));
    const friends = JSON.parse(fs.readFileSync(path.join(dataDir, "responses", "friendslist2.json"), "utf8"));
    assert(friends.friends.some((f) => f.accountId === ACCOUNT), "friendslist2.json im Daten-Ordner nicht aktualisiert");
    eq(JSON.parse(fs.readFileSync(path.join(dataDir, "responses", "privacy.json"), "utf8")).optOutOfPublicLeaderboards, true, "privacy.json im Daten-Ordner");
  });

  await check("Fehler in einem LawinServer-Handler → 500-Antwort statt hängender Anfrage", async () => {
    const res = await mcp(B, "QueryProfile", "gibtsnicht");
    eq(res.status, 500, "Status");
    eq((await request("GET", `${B}/vanity/health`)).status, 200, "Backend läuft weiter");
  });

  // Spind ändern (so macht es 19.10) und prüfen, dass es im Daten-Ordner landet
  const lockerItem = athena && Object.keys(athena.items).find((k) => athena.items[k].templateId === "CosmeticLocker:cosmeticlocker_athena");
  const skin = athena && (["AthenaCharacter:cid_028_athena_commando_f"].find((k) => k in athena.items) ?? Object.keys(athena.items).find((k) => k.startsWith("AthenaCharacter:")));
  await check(`SetCosmeticLockerSlot Character = ${skin} → im Daten-Ordner gespeichert`, async () => {
    assert(lockerItem && skin, "Spind oder Skin im Profil nicht gefunden");
    const res = await mcp(B, "SetCosmeticLockerSlot", "athena", {
      lockerItem,
      category: "Character",
      itemToSlot: skin,
      slotIndex: 0,
      variantUpdates: [],
      optLockerUseCountOverride: -1,
    });
    eq(res.status, 200, "Status");
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "profiles", "athena.json"), "utf8"));
    eq(saved.items[lockerItem].attributes.locker_slots_data.slots.Character.items[0], skin, "gespeicherter Skin");
  });

  await check("ClientSettings.Sav PUT/GET → liegt im Daten-Ordner", async () => {
    const data = Buffer.from("VANITY-CLIENTSETTINGS-äöü", "latin1");
    const put = await request("PUT", `${B}/fortnite/api/cloudstorage/user/${ACCOUNT}/ClientSettings.Sav`, {
      body: data,
      headers: { "Content-Type": "application/octet-stream" },
    });
    eq(put.status, 204, "PUT-Status");
    const file = path.join(dataDir, "ClientSettings", "ClientSettings-18775446.Sav");
    assert(fs.existsSync(file), "ClientSettings-18775446.Sav fehlt im Daten-Ordner");
    const list = (await request("GET", `${B}/fortnite/api/cloudstorage/user/${ACCOUNT}`)).json();
    eq(list[0]?.filename, "ClientSettings.Sav", "Liste");
    const get = await request("GET", `${B}/fortnite/api/cloudstorage/user/${ACCOUNT}/ClientSettings.Sav`);
    assert(get.buf.equals(data), "Inhalt stimmt nicht");
  });

  await check("GET /content/api/pages/fortnite-game", async () => {
    const res = await request("GET", `${B}/content/api/pages/fortnite-game`);
    eq(res.status, 200, "Status");
    const j = res.json();
    assert(j.battleroyalenews || j.dynamicbackgrounds, "keine Content-Pages");
  });

  await check("GET /fortnite/api/cloudstorage/system → .ini-Liste", async () => {
    const list = (await request("GET", `${B}/fortnite/api/cloudstorage/system`)).json();
    const names = list.map((f) => f.filename);
    for (const n of ["DefaultEngine.ini", "DefaultGame.ini", "DefaultRuntimeOptions.ini"]) assert(names.includes(n), `${n} fehlt`);
  });

  await check(`DefaultEngine.ini: XMPP-ServerPort=${mmPort}`, async () => {
    const res = await request("GET", `${B}/fortnite/api/cloudstorage/system/DefaultEngine.ini`);
    eq(res.status, 200, "Status");
    assert(res.text.includes(`ServerPort=${mmPort}`), "ServerPort nicht angepasst");
    assert(!/^ServerPort=80\s*$/m.test(res.text), "ServerPort=80 noch drin");
  });

  await check("cloudstorage/system/..%2F.. liefert keine fremden Dateien", async () => {
    const res = await request("GET", `${B}/fortnite/api/cloudstorage/system/..%2FConfig%2Fconfig.ini`);
    assert(!res.text.includes("[GameServer]"), "Pfad außerhalb von CloudStorage gelesen");
  });

  await check("MCP profileId=..%2F.. → 400", async () => {
    const res = await request("POST", `${B}/fortnite/api/game/v2/profile/${ACCOUNT}/client/QueryProfile?profileId=..%2FConfig%2Fx&rvn=-1`, { body: {} });
    eq(res.status, 400, "Status");
  });

  // Matchmaking wie 19.10
  let sessionId;
  await check("Matchmaking-Ticket → serviceUrl ws://127.0.0.1:<Matchmaker-Port>", async () => {
    const res = await request("GET", `${B}/fortnite/api/game/v2/matchmakingservice/ticket/player/${ACCOUNT}?partyPlayerIds=${ACCOUNT}&bucketId=18675304:0:EU:playlist_defaultsolo&player.platform=Windows&player.subregions=DE,GB&player.option.crossplayOptOut=false`);
    eq(res.status, 200, "Status");
    const j = res.json();
    eq(j.serviceUrl, `ws://127.0.0.1:${mmPort}`, "serviceUrl");
    eq(j.ticketType, "mms-player", "ticketType");

    const states = await new Promise((resolve, reject) => {
      const seen = [];
      const ws = new WebSocket(j.serviceUrl, { headers: { Authorization: `Epic-Signed ${j.ticketType} ${j.payload} ${j.signature}` } });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`keine Play-Nachricht nach 15 s, bisher: ${seen.join(", ")}`));
      }, 15000);
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.name === "StatusUpdate") seen.push(msg.payload.state);
        if (msg.name === "Play") {
          seen.push("Play");
          sessionId = msg.payload.sessionId;
          clearTimeout(timer);
          ws.close();
          resolve(seen);
        }
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    eq(states.join(" → "), "Connecting → Waiting → Queued → SessionAssignment → Play", "Ablauf");
    assert(sessionId, "sessionId fehlt");
  });

  const session = async () => {
    const res = await request("GET", `${B}/fortnite/api/matchmaking/session/${sessionId ?? "test"}`, {
      headers: { Cookie: "currentbuildUniqueId=18675304" },
    });
    eq(res.status, 200, "Status");
    return res.json();
  };

  await check("GET /fortnite/api/matchmaking/session/<id> → serverAddress aus VANITY_GAMESERVER", async () => {
    const j = await session();
    eq(j.serverAddress, "10.20.30.40", "serverAddress");
    eq(j.serverPort, 7778, "serverPort");
    eq(j.buildUniqueId, "18675304", "buildUniqueId");
  });

  await check("POST /vanity/gameserver {100.101.12.7:7777} → Session zeigt neues Ziel", async () => {
    const res = await request("POST", `${B}/vanity/gameserver`, { body: { ip: "100.101.12.7", port: 7777 } });
    eq(res.status, 200, "Status");
    eq(res.json().gameServer.ip, "100.101.12.7", "Antwort");
    const j = await session();
    eq(j.serverAddress, "100.101.12.7", "serverAddress");
    eq(j.serverPort, 7777, "serverPort");
    eq((await request("GET", `${B}/vanity/status`)).json().gameServer.ip, "100.101.12.7", "status.gameServer");
  });

  await check("POST /vanity/gameserver: ungültig → 400, text/plain → 415", async () => {
    eq((await request("POST", `${B}/vanity/gameserver`, { body: { ip: "1.2.3.4", port: 70000 } })).status, 400, "Port 70000");
    eq((await request("POST", `${B}/vanity/gameserver`, { body: { port: 7777 } })).status, 400, "ip fehlt");
    eq((await request("POST", `${B}/vanity/gameserver`, { body: "{nope", headers: { "Content-Type": "application/json" } })).status, 400, "kaputtes JSON");
    eq((await request("POST", `${B}/vanity/gameserver`, { body: '{"ip":"1.2.3.4"}', headers: { "Content-Type": "text/plain" } })).status, 415, "text/plain");
    eq((await session()).serverAddress, "100.101.12.7", "Ziel unverändert");
  });

  await check("POST /vanity/status setzt Felder, GET liefert sie", async () => {
    const update = { name: "Georgs Server", hosting: true, playlist: "Playlist_DefaultSolo", players: 3, maxPlayers: 100, version: "19.10" };
    const res = await request("POST", `${B}/vanity/status`, { body: update });
    eq(res.status, 200, "Status");
    const j = (await request("GET", `${B}/vanity/status`)).json();
    for (const [k, v] of Object.entries(update)) eq(j[k], v, k);
    eq((await request("POST", `${B}/vanity/status`, { body: { players: "drei" } })).status, 400, "falscher Typ");
  });

  await check("XMPP: open + PLAIN-Login über den Matchmaker-Port", async () => {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${mmPort}`, "xmpp");
      const got = [];
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`XMPP-Antworten unvollständig: ${got.join(" | ").slice(0, 300)}`));
      }, 5000);
      ws.on("open", () => ws.send('<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="prod.ol.epicgames.com" version="1.0"/>'));
      ws.on("message", (raw) => {
        const text = raw.toString();
        got.push(text);
        if (text.includes("<stream:features") && text.includes("PLAIN")) {
          const auth = Buffer.from(`\u0000${ACCOUNT}\u0000lawinstokenlol`).toString("base64");
          ws.send(`<auth mechanism="PLAIN" xmlns="urn:ietf:params:xml:ns:xmpp-sasl">${auth}</auth>`);
        }
        if (text.includes("<success")) {
          clearTimeout(timer);
          ws.close();
          resolve();
        }
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  });

  await check("unbekannter /vanity-Pfad → 404, Epic-Pfad → LawinServer-404", async () => {
    eq((await request("GET", `${B}/vanity/nope`)).status, 404, "/vanity/nope");
    const res = await request("GET", `${B}/does/not/exist`);
    eq(res.status, 404, "Status");
    eq(res.json().errorCode, "errors.com.lawinserver.common.not_found", "errorCode");
  });

  await check("Log-Zeilen im Format [HTTP] METHOD /pfad → status", async () => {
    assert(s1.lines.includes("[HTTP] GET /vanity/health → 200"), "health-Zeile fehlt");
    assert(s1.lines.includes("[HTTP] POST /account/api/oauth/token → 200"), "oauth-Zeile fehlt");
    assert(s1.lines.includes("[HTTP] POST /vanity/gameserver → 415"), "415-Zeile fehlt");
    assert(s1.lines.some((l) => l.startsWith("[HTTP] POST /fortnite/api/game/v2/profile/georg/client/QueryProfile → 200")), "MCP-Zeile ohne Query-String fehlt");
  });

  await s1.stop();

  // Neustart: Spind muss erhalten bleiben, Standard-Dateien dürfen nichts überschreiben
  const env2 = { ...env, VANITY_BACKEND_PORT: String(await freePort()), VANITY_MATCHMAKER_PORT: String(await freePort()) };
  console.log(`\nServer 2 (Neustart, gleicher Daten-Ordner): HTTP ${env2.VANITY_BACKEND_PORT}`);
  const s2 = await startServer(env2, "Server 2");
  servers.push(s2);

  await check("nach Neustart: Skin im Spind noch gesetzt", async () => {
    const j = (await mcp(s2.base, "QueryProfile", "athena")).json();
    eq(j.profileChanges[0].profile.items[lockerItem].attributes.locker_slots_data.slots.Character.items[0], skin, "Skin");
  });

  await check("nach Neustart: keine Standard-Dateien erneut kopiert", async () => {
    assert(s2.lines.some((l) => l.startsWith("[Vanity] Daten-Ordner:") && !l.includes("kopiert")), s2.lines.find((l) => l.includes("Daten-Ordner")) ?? "Zeile fehlt");
  });

  await check("dist/ unverändert (alles Schreiben ging in den Daten-Ordner)", async () => {
    eq(sha1(distAthena), distAthenaHash, "dist/profiles/athena.json");
    eq(listFiles(path.join(ROOT, "dist")).length, distFilesBefore, "Anzahl Dateien in dist/");
    assert(!listFiles(dataDir).some((f) => f.endsWith(".tmp")), "übrig gebliebene .tmp-Datei");
  });

  await s2.stop();

  // Zugriff aus dem Netzwerk: POST nur von 127.0.0.1
  const lanIp = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  if (!lanIp) {
    skip("403 für POST aus dem Netzwerk", "keine Nicht-Loopback-IPv4-Adresse gefunden");
  } else {
    const env3 = { ...env, VANITY_BIND: "0.0.0.0", VANITY_BACKEND_PORT: String(await freePort()), VANITY_MATCHMAKER_PORT: String(await freePort()) };
    console.log(`\nServer 3 (VANITY_BIND=0.0.0.0, Zugriff über ${lanIp}): HTTP ${env3.VANITY_BACKEND_PORT}`);
    const s3 = await startServer(env3, "Server 3");
    servers.push(s3);
    const remote = `http://${lanIp}:${env3.VANITY_BACKEND_PORT}`;

    await check(`über ${lanIp}: GET /vanity/health + /vanity/status → 200`, async () => {
      eq((await request("GET", `${remote}/vanity/health`)).status, 200, "health");
      const res = await request("GET", `${remote}/vanity/status`);
      eq(res.status, 200, "status");
      eq(res.headers["access-control-allow-origin"], "*", "CORS-Header");
    });

    await check(`über ${lanIp}: POST /vanity/gameserver + /vanity/status → 403`, async () => {
      eq((await request("POST", `${remote}/vanity/gameserver`, { body: { ip: "6.6.6.6", port: 7777 } })).status, 403, "gameserver");
      eq((await request("POST", `${remote}/vanity/status`, { body: { name: "x" } })).status, 403, "status");
      eq((await request("GET", `${s3.base}/vanity/status`)).json().gameServer.ip, "10.20.30.40", "Ziel unverändert");
    });

    await check("über 127.0.0.1 am selben Server: POST erlaubt", async () => {
      eq((await request("POST", `${s3.base}/vanity/gameserver`, { body: { ip: "100.101.12.7", port: 7777 } })).status, 200, "gameserver");
    });

    await s3.stop();
  }

  await check("ungültige Umgebungsvariable → Exit-Code 1", async () => {
    const child = spawn(process.execPath, [MAIN], { env: { ...process.env, ...env, VANITY_BACKEND_PORT: "abc" }, stdio: "ignore" });
    const code = await new Promise((r) => child.on("exit", r));
    eq(code, 1, "Exit-Code");
  });
} catch (err) {
  results.fail++;
  console.log(`  FAIL  ${err.stack ?? err}`);
} finally {
  for (const s of servers) await s.stop().catch(() => {});
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${results.ok} OK, ${results.fail} FEHLER, ${results.skip} übersprungen`);
process.exit(results.fail ? 1 : 0);
