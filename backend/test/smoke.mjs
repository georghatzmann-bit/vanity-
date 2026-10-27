// Smoke test for the built backend (dist/main.js).
// Starts the server on free ports with an empty temp data folder and replays what a
// Fortnite 19.10 client asks for at login, in the locker and in matchmaking.
// Run: pnpm build && pnpm test      (exit code ≠ 0 if a check fails)
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
  console.error("dist/main.js is missing – run `pnpm build` first.");
  process.exit(2);
}

// ---------------------------------------------------------------- Helpers

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
  assert(actual === expected, `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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
              throw new Error(`no JSON answer (${res.statusCode}): ${text.slice(0, 200)}`);
            }
          },
        });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`Timed out: ${method} ${url}`)));
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function startServer(env, label) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rift-cwd-")); // any working folder
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

  const base = `http://127.0.0.1:${env.NIOBIUM_BACKEND_PORT}`;
  const deadline = Date.now() + 20000;
  const fail = (message) => {
    child.kill("SIGKILL");
    fs.rmSync(cwd, { recursive: true, force: true });
    throw new Error(`${label}: ${message}:\n${lines.join("\n")}`);
  };
  for (;;) {
    if (exited !== null) fail(`server exited (code ${exited})`);
    try {
      const res = await request("GET", `${base}/niobium/health`);
      if (res.status === 200) break;
    } catch {}
    if (Date.now() > deadline) fail("/niobium/health doesn't answer");
    await new Promise((r) => setTimeout(r, 100));
  }
  // XMPP/matchmaker starts right after the HTTP port
  while (!lines.some((l) => l.includes("XMPP and Matchmaker"))) {
    if (Date.now() > deadline) fail("the matchmaker port doesn't start");
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

// ---------------------------------------------------------------- Run

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rift-data-"));
const distAthena = path.join(ROOT, "dist", "profiles", "athena.json");
const distAthenaHash = sha1(distAthena);
const distFilesBefore = listFiles(path.join(ROOT, "dist")).length;
const servers = [];

try {
  const httpPort = await freePort();
  const mmPort = await freePort();
  const env = {
    NIOBIUM_BACKEND_PORT: String(httpPort),
    NIOBIUM_MATCHMAKER_PORT: String(mmPort),
    NIOBIUM_BIND: "127.0.0.1",
    NIOBIUM_DATA_DIR: dataDir,
    NIOBIUM_GAMESERVER: "10.20.30.40:7778",
  };

  console.log(`\nServer 1: HTTP ${httpPort}, matchmaker/XMPP ${mmPort}, data ${dataDir}`);
  const s1 = await startServer(env, "Server 1");
  servers.push(s1);
  const B = s1.base;

  await check("GET /niobium/health → { ok: true, version }", async () => {
    const res = await request("GET", `${B}/niobium/health`);
    eq(res.status, 200, "Status");
    const j = res.json();
    eq(j.ok, true, "ok");
    assert(typeof j.version === "string" && j.version.length > 0, "version is missing");
  });

  await check("GET /niobium/status → all fields, gameServer from NIOBIUM_GAMESERVER", async () => {
    const j = (await request("GET", `${B}/niobium/status`)).json();
    for (const key of ["name", "hosting", "playlist", "players", "maxPlayers", "version", "gameServer"]) assert(key in j, `field ${key} is missing`);
    eq(j.gameServer.ip, "10.20.30.40", "gameServer.ip");
    eq(j.gameServer.port, 7778, "gameServer.port");
  });

  await check("data folder filled on the first start", async () => {
    for (const rel of ["profiles/athena.json", "profiles/common_core.json", "Config/config.ini", "Config/catalog_config.json", "responses/friendslist.json", "responses/privacy.json", "responses/Athena/SeasonData.json"]) {
      assert(fs.existsSync(path.join(dataDir, rel)), `${rel} is missing in the data folder`);
    }
    assert(fs.statSync(path.join(dataDir, "ClientSettings")).isDirectory(), "ClientSettings/ is missing");
  });

  await check("POST /account/api/oauth/token (password, georg@niobium.local) → name georg", async () => {
    const res = await request("POST", `${B}/account/api/oauth/token`, {
      form: { grant_type: "password", username: `${ACCOUNT}@niobium.local`, password: "niobium" },
      headers: { Authorization: "basic ZWM2ODRiOGM2ODdmNDc5ZmFkZWEzY2IyYWQ4M2Y1YzY6ZTFmMzFjMjExZjI4NDEzMTg2MjYyZDM3YTEzZmM4NGQ=" },
    });
    eq(res.status, 200, "Status");
    const j = res.json();
    eq(j.account_id, ACCOUNT, "account_id");
    eq(j.displayName, ACCOUNT, "displayName");
    assert(j.access_token, "access_token is missing");
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
    assert(Object.keys(athena.items).length > 1000, "too few items");
  });

  await check("QueryProfile common_core", async () => {
    const j = (await mcp(B, "QueryProfile", "common_core")).json();
    eq(j.profileId, "common_core", "profileId");
    eq(j.profileChanges[0]?.profile?.profileId, "common_core", "profile.profileId");
  });

  await check("more login/lobby requests from 19.10 → no errors", async () => {
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
    assert(friends.friends.some((f) => f.accountId === ACCOUNT), "friendslist2.json in the data folder not updated");
    eq(JSON.parse(fs.readFileSync(path.join(dataDir, "responses", "privacy.json"), "utf8")).optOutOfPublicLeaderboards, true, "privacy.json in the data folder");
  });

  await check("error in a LawinServer handler → 500 answer instead of a hanging request", async () => {
    const res = await mcp(B, "QueryProfile", "doesnotexist");
    eq(res.status, 500, "Status");
    eq((await request("GET", `${B}/niobium/health`)).status, 200, "backend keeps running");
  });

  // Change the locker (the way 19.10 does it) and check that it lands in the data folder
  const lockerItem = athena && Object.keys(athena.items).find((k) => athena.items[k].templateId === "CosmeticLocker:cosmeticlocker_athena");
  const skin = athena && (["AthenaCharacter:cid_028_athena_commando_f"].find((k) => k in athena.items) ?? Object.keys(athena.items).find((k) => k.startsWith("AthenaCharacter:")));
  await check(`SetCosmeticLockerSlot Character = ${skin} → saved in the data folder`, async () => {
    assert(lockerItem && skin, "locker or skin not found in the profile");
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
    eq(saved.items[lockerItem].attributes.locker_slots_data.slots.Character.items[0], skin, "saved skin");
  });

  await check("ClientSettings.Sav PUT/GET → stored in the data folder", async () => {
    const data = Buffer.from("NIOBIUM-CLIENTSETTINGS-äöü", "latin1");
    const put = await request("PUT", `${B}/fortnite/api/cloudstorage/user/${ACCOUNT}/ClientSettings.Sav`, {
      body: data,
      headers: { "Content-Type": "application/octet-stream" },
    });
    eq(put.status, 204, "PUT status");
    const file = path.join(dataDir, "ClientSettings", "ClientSettings-18775446.Sav");
    assert(fs.existsSync(file), "ClientSettings-18775446.Sav is missing in the data folder");
    const list = (await request("GET", `${B}/fortnite/api/cloudstorage/user/${ACCOUNT}`)).json();
    eq(list[0]?.filename, "ClientSettings.Sav", "list");
    const get = await request("GET", `${B}/fortnite/api/cloudstorage/user/${ACCOUNT}/ClientSettings.Sav`);
    assert(get.buf.equals(data), "content doesn't match");
  });

  await check("GET /content/api/pages/fortnite-game", async () => {
    const res = await request("GET", `${B}/content/api/pages/fortnite-game`);
    eq(res.status, 200, "Status");
    const j = res.json();
    assert(j.battleroyalenews || j.dynamicbackgrounds, "no content pages");
  });

  await check("GET /fortnite/api/cloudstorage/system → .ini list", async () => {
    const list = (await request("GET", `${B}/fortnite/api/cloudstorage/system`)).json();
    const names = list.map((f) => f.filename);
    for (const n of ["DefaultEngine.ini", "DefaultGame.ini", "DefaultRuntimeOptions.ini"]) assert(names.includes(n), `${n} is missing`);
  });

  await check(`DefaultEngine.ini: XMPP ServerPort=${mmPort}`, async () => {
    const res = await request("GET", `${B}/fortnite/api/cloudstorage/system/DefaultEngine.ini`);
    eq(res.status, 200, "Status");
    assert(res.text.includes(`ServerPort=${mmPort}`), "ServerPort not changed");
    assert(!/^ServerPort=80\s*$/m.test(res.text), "ServerPort=80 still there");
  });

  await check("cloudstorage/system/..%2F.. returns no other files", async () => {
    const res = await request("GET", `${B}/fortnite/api/cloudstorage/system/..%2FConfig%2Fconfig.ini`);
    assert(!res.text.includes("[GameServer]"), "read a path outside CloudStorage");
  });

  await check("MCP profileId=..%2F.. → 400", async () => {
    const res = await request("POST", `${B}/fortnite/api/game/v2/profile/${ACCOUNT}/client/QueryProfile?profileId=..%2FConfig%2Fx&rvn=-1`, { body: {} });
    eq(res.status, 400, "Status");
  });

  // Matchmaking like 19.10
  let sessionId;
  await check("matchmaking ticket → serviceUrl ws://127.0.0.1:<matchmaker port>", async () => {
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
        reject(new Error(`no Play message after 15 s, so far: ${seen.join(", ")}`));
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
    eq(states.join(" → "), "Connecting → Waiting → Queued → SessionAssignment → Play", "sequence");
    assert(sessionId, "sessionId is missing");
  });

  const session = async () => {
    const res = await request("GET", `${B}/fortnite/api/matchmaking/session/${sessionId ?? "test"}`, {
      headers: { Cookie: "currentbuildUniqueId=18675304" },
    });
    eq(res.status, 200, "Status");
    return res.json();
  };

  await check("GET /fortnite/api/matchmaking/session/<id> → serverAddress from NIOBIUM_GAMESERVER", async () => {
    const j = await session();
    eq(j.serverAddress, "10.20.30.40", "serverAddress");
    eq(j.serverPort, 7778, "serverPort");
    eq(j.buildUniqueId, "18675304", "buildUniqueId");
  });

  await check("POST /niobium/gameserver {100.101.12.7:7777} → session shows the new target", async () => {
    const res = await request("POST", `${B}/niobium/gameserver`, { body: { ip: "100.101.12.7", port: 7777 } });
    eq(res.status, 200, "Status");
    eq(res.json().gameServer.ip, "100.101.12.7", "answer");
    const j = await session();
    eq(j.serverAddress, "100.101.12.7", "serverAddress");
    eq(j.serverPort, 7777, "serverPort");
    eq((await request("GET", `${B}/niobium/status`)).json().gameServer.ip, "100.101.12.7", "status.gameServer");
  });

  await check("POST /niobium/gameserver: invalid → 400, text/plain → 415", async () => {
    eq((await request("POST", `${B}/niobium/gameserver`, { body: { ip: "1.2.3.4", port: 70000 } })).status, 400, "Port 70000");
    eq((await request("POST", `${B}/niobium/gameserver`, { body: { port: 7777 } })).status, 400, "ip missing");
    eq((await request("POST", `${B}/niobium/gameserver`, { body: "{nope", headers: { "Content-Type": "application/json" } })).status, 400, "broken JSON");
    eq((await request("POST", `${B}/niobium/gameserver`, { body: '{"ip":"1.2.3.4"}', headers: { "Content-Type": "text/plain" } })).status, 415, "text/plain");
    eq((await session()).serverAddress, "100.101.12.7", "target unchanged");
  });

  await check("POST /niobium/status sets fields, GET returns them", async () => {
    const update = { name: "georg's server", hosting: true, playlist: "Playlist_DefaultSolo", players: 3, maxPlayers: 100, version: "19.10" };
    const res = await request("POST", `${B}/niobium/status`, { body: update });
    eq(res.status, 200, "Status");
    const j = (await request("GET", `${B}/niobium/status`)).json();
    for (const [k, v] of Object.entries(update)) eq(j[k], v, k);
    eq((await request("POST", `${B}/niobium/status`, { body: { players: "three" } })).status, 400, "wrong type");
  });

  await check("XMPP: open + PLAIN login over the matchmaker port", async () => {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${mmPort}`, "xmpp");
      const got = [];
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`XMPP answers incomplete: ${got.join(" | ").slice(0, 300)}`));
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

  await check("unknown /niobium path → 404, Epic path → LawinServer 404", async () => {
    eq((await request("GET", `${B}/niobium/nope`)).status, 404, "/niobium/nope");
    const res = await request("GET", `${B}/does/not/exist`);
    eq(res.status, 404, "Status");
    eq(res.json().errorCode, "errors.com.lawinserver.common.not_found", "errorCode");
  });

  await check("log lines in the format [HTTP] METHOD /path → status", async () => {
    assert(s1.lines.includes("[HTTP] GET /niobium/health → 200"), "health line missing");
    assert(s1.lines.includes("[HTTP] POST /account/api/oauth/token → 200"), "oauth line missing");
    assert(s1.lines.includes("[HTTP] POST /niobium/gameserver → 415"), "415 line missing");
    assert(s1.lines.some((l) => l.startsWith("[HTTP] POST /fortnite/api/game/v2/profile/georg/client/QueryProfile → 200")), "MCP line without query string missing");
  });

  await s1.stop();

  // Restart: the locker must stay, default files must not overwrite anything
  const env2 = { ...env, NIOBIUM_BACKEND_PORT: String(await freePort()), NIOBIUM_MATCHMAKER_PORT: String(await freePort()) };
  console.log(`\nServer 2 (restart, same data folder): HTTP ${env2.NIOBIUM_BACKEND_PORT}`);
  const s2 = await startServer(env2, "Server 2");
  servers.push(s2);

  await check("after restart: skin still set in the locker", async () => {
    const j = (await mcp(s2.base, "QueryProfile", "athena")).json();
    eq(j.profileChanges[0].profile.items[lockerItem].attributes.locker_slots_data.slots.Character.items[0], skin, "Skin");
  });

  await check("after restart: no default files copied again", async () => {
    assert(s2.lines.some((l) => l.startsWith("[Rift] Data folder:") && !l.includes("copied")), s2.lines.find((l) => l.includes("Data folder")) ?? "line missing");
  });

  await check("dist/ unchanged (every write went to the data folder)", async () => {
    eq(sha1(distAthena), distAthenaHash, "dist/profiles/athena.json");
    eq(listFiles(path.join(ROOT, "dist")).length, distFilesBefore, "number of files in dist/");
    assert(!listFiles(dataDir).some((f) => f.endsWith(".tmp")), "left-over .tmp file");
  });

  await s2.stop();

  // Matchmaker port taken + a damaged data file (e.g. copied over from an old Niobium install)
  {
    const blocker = net.createServer();
    const takenPort = await freePort();
    await new Promise((r) => blocker.listen(takenPort, "127.0.0.1", r));
    fs.writeFileSync(path.join(dataDir, "responses", "friendslist.json"), "");
    const env4 = { ...env, NIOBIUM_BACKEND_PORT: String(await freePort()), NIOBIUM_MATCHMAKER_PORT: String(takenPort) };
    console.log(`\nServer 4 (matchmaker port ${takenPort} taken, damaged friendslist.json): HTTP ${env4.NIOBIUM_BACKEND_PORT}`);
    const s4 = await startServer(env4, "Server 4");
    servers.push(s4);

    await check("matchmaker port taken → free port, logged, health + serviceUrl use it", async () => {
      const line = s4.lines.find((l) => l.includes(`Matchmaker port 127.0.0.1:${takenPort} is already in use – using port`));
      assert(line, `log line missing:\n${s4.lines.join("\n")}`);
      const used = Number(/using port (\d+)/.exec(line)[1]);
      assert(used !== takenPort && used > 0, `port ${used}`);
      eq((await request("GET", `${s4.base}/niobium/health`)).json().matchmakerPort, used, "health matchmakerPort");
      const ticket = await request("GET", `${s4.base}/fortnite/api/game/v2/matchmakingservice/ticket/player/${ACCOUNT}?bucketId=1:0:EU:playlist_defaultsolo`);
      eq(ticket.json().serviceUrl, `ws://127.0.0.1:${used}`, "serviceUrl");
      const ini = await request("GET", `${s4.base}/fortnite/api/cloudstorage/system/DefaultEngine.ini`, { headers: { "User-Agent": UA } });
      assert(ini.text.includes(`ServerPort=${used}`), "XMPP ServerPort in DefaultEngine.ini");
    });

    await check("damaged friendslist.json → kept as .broken, default put back, backend runs", async () => {
      assert(fs.existsSync(path.join(dataDir, "responses", "friendslist.json.broken")), ".broken missing");
      JSON.parse(fs.readFileSync(path.join(dataDir, "responses", "friendslist.json"), "utf8"));
      assert(s4.lines.some((l) => l.includes("friendslist.json was damaged")), "log line missing");
    });

    await s4.stop();

    await check("HTTP port taken → exit code 1, last stderr line names the port", async () => {
      const env5 = { ...env, NIOBIUM_BACKEND_PORT: String(takenPort), NIOBIUM_MATCHMAKER_PORT: String(await freePort()) };
      const child = spawn(process.execPath, [MAIN], { env: { ...process.env, ...env5 }, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      const code = await new Promise((r) => child.on("exit", r));
      eq(code, 1, "exit code");
      eq(stderr.trim().split("\n").pop(), `[Rift] HTTP port 127.0.0.1:${takenPort} is already in use`, "last stderr line");
    });
    blocker.close();
  }

  // Access from the network: POST only from 127.0.0.1
  const lanIp = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  if (!lanIp) {
    skip("403 for POST from the network", "no non-loopback IPv4 address found");
  } else {
    const env3 = { ...env, NIOBIUM_BIND: "0.0.0.0", NIOBIUM_BACKEND_PORT: String(await freePort()), NIOBIUM_MATCHMAKER_PORT: String(await freePort()) };
    console.log(`\nServer 3 (NIOBIUM_BIND=0.0.0.0, access via ${lanIp}): HTTP ${env3.NIOBIUM_BACKEND_PORT}`);
    const s3 = await startServer(env3, "Server 3");
    servers.push(s3);
    const remote = `http://${lanIp}:${env3.NIOBIUM_BACKEND_PORT}`;

    await check(`via ${lanIp}: GET /niobium/health + /niobium/status → 200`, async () => {
      eq((await request("GET", `${remote}/niobium/health`)).status, 200, "health");
      const res = await request("GET", `${remote}/niobium/status`);
      eq(res.status, 200, "status");
      eq(res.headers["access-control-allow-origin"], "*", "CORS header");
    });

    await check(`via ${lanIp}: POST /niobium/gameserver + /niobium/status → 403`, async () => {
      eq((await request("POST", `${remote}/niobium/gameserver`, { body: { ip: "6.6.6.6", port: 7777 } })).status, 403, "gameserver");
      eq((await request("POST", `${remote}/niobium/status`, { body: { name: "x" } })).status, 403, "status");
      eq((await request("GET", `${s3.base}/niobium/status`)).json().gameServer.ip, "10.20.30.40", "target unchanged");
    });

    await check("via 127.0.0.1 on the same server: POST allowed", async () => {
      eq((await request("POST", `${s3.base}/niobium/gameserver`, { body: { ip: "100.101.12.7", port: 7777 } })).status, 200, "gameserver");
    });

    await s3.stop();
  }

  await check("invalid environment variable → exit code 1", async () => {
    const child = spawn(process.execPath, [MAIN], { env: { ...process.env, ...env, NIOBIUM_BACKEND_PORT: "abc" }, stdio: "ignore" });
    const code = await new Promise((r) => child.on("exit", r));
    eq(code, 1, "exit code");
  });
} catch (err) {
  results.fail++;
  console.log(`  FAIL  ${err.stack ?? err}`);
} finally {
  for (const s of servers) await s.stop().catch(() => {});
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${results.ok} OK, ${results.fail} FAILED, ${results.skip} skipped`);
process.exit(results.fail ? 1 : 0);
