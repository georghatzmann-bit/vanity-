// Version test: does the backend do the right thing for many Fortnite versions?
// Starts the built backend once and asks the most important start endpoints for every version
// (via the User-Agent). Expected: never 5xx, the season is right, the hotfix rule for 9.40–10.40
// works, the stub answers for newer builds are there.
// Run: pnpm build && node test/versions.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = path.join(ROOT, "dist", "main.js");
if (!fs.existsSync(MAIN)) {
  console.error("dist/main.js is missing – run `pnpm build` first.");
  process.exit(2);
}

// Version → expected season. Covers Chapter 1 to Chapter 6, also versions the launcher doesn't start (yet).
const VERSIONS = [
  ["1.8", 1], ["3.5", 3], ["5.41", 5], ["7.40", 7], ["9.41", 9], ["10.40", 10], ["12.41", 12],
  ["15.10", 15], ["19.10", 19], ["20.40", 20], ["23.10", 23], ["27.11", 27], ["28.01", 28],
  ["30.10", 30], ["33.00", 33], ["36.20", 36], ["41.30", 41],
];
const ACCOUNT = "versionstest";

const results = { ok: 0, fail: 0 };
function report(ok, text) {
  results[ok ? "ok" : "fail"]++;
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${text}`);
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

function request(method, url, ua, { headers = {}, form, body } = {}) {
  return new Promise((resolve, reject) => {
    let payload;
    const h = { "User-Agent": ua, ...headers };
    if (form) {
      payload = new URLSearchParams(form).toString();
      h["Content-Type"] = "application/x-www-form-urlencoded";
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      h["Content-Type"] = "application/json";
    }
    if (payload !== undefined) h["Content-Length"] = Buffer.byteLength(payload);
    const req = http.request(url, { method, headers: h, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, text, json: () => JSON.parse(text) });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`Timed out: ${method} ${url}`)));
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "niobium-versions-"));
const env = {
  NIOBIUM_BACKEND_PORT: String(await freePort()),
  NIOBIUM_MATCHMAKER_PORT: String(await freePort()),
  NIOBIUM_BIND: "127.0.0.1",
  NIOBIUM_DATA_DIR: dataDir,
};
const child = spawn(process.execPath, [MAIN], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
const base = `http://127.0.0.1:${env.NIOBIUM_BACKEND_PORT}`;
const deadline = Date.now() + 20000;
for (;;) {
  try {
    if ((await request("GET", `${base}/niobium/health`, "test")).status === 200) break;
  } catch {}
  if (Date.now() > deadline) {
    console.error("The backend doesn't start");
    child.kill("SIGKILL");
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, 100));
}

try {
  for (const [version, season] of VERSIONS) {
    const ua = `Fortnite/++Fortnite+Release-${version}-CL-123456 Windows/10.0.22621.1.256.64bit`;
    const [major, minor = "0"] = version.split(".");
    const build = Number(`${major}.${minor}`);

    // Log in the way the build does
    const token = await request("POST", `${base}/account/api/oauth/token`, ua, {
      headers: { Authorization: "basic ZWM2ODRiOGM2ODdmNDc5ZmFkZWEzY2IyYWQ4M2Y1YzY6ZTFmMzFjMjExZjI4NDEzMTg2MjYyZDM3YTEzZmM4NGQ=" },
      form: { grant_type: "password", username: `${ACCOUNT}@niobium.local`, password: "niobium" },
    });
    report(token.status === 200, `${version}: login (${token.status})`);
    const auth = token.status === 200 ? { Authorization: `bearer ${token.json().access_token}` } : {};
    const accountId = token.status === 200 ? token.json().account_id : ACCOUNT;

    const calls = [
      ["GET", `/fortnite/api/calendar/v1/timeline`],
      ["GET", `/lightswitch/api/service/bulk/status?serviceId=Fortnite`],
      ["GET", `/fortnite/api/v2/versioncheck/Windows?version=%2B%2BFortnite%2BRelease-${version}-CL-123456-Windows`],
      ["GET", `/content/api/pages/fortnite-game`],
      ["GET", `/fortnite/api/storefront/v2/catalog`],
      ["GET", `/fortnite/api/cloudstorage/system`],
      ["POST", `/fortnite/api/game/v2/profile/${accountId}/client/QueryProfile?profileId=athena&rvn=-1`, {}],
      ["POST", `/fortnite/api/game/v2/profile/${accountId}/client/QueryProfile?profileId=common_core&rvn=-1`, {}],
      ["GET", `/fortnite/api/game/v2/matchmakingservice/ticket/player/${accountId}?partyPlayerIds=${accountId}&bucketId=123456:1:EU:playlist_defaultsolo`],
      ["POST", `/caldera/api/v1/launcher/racp`, { account_id: accountId }],
      ["GET", `/content-controls/${accountId}`],
      ["GET", `/presence/api/v1/_/${accountId}/settings/subscriptions`],
      ["GET", `/api/v1/user/setting`],
    ];
    let serverErrors = 0;
    for (const [method, route, body] of calls) {
      const res = await request(method, base + route, ua, { headers: auth, body });
      if (res.status >= 500) {
        serverErrors++;
        console.log(`        5xx: ${method} ${route} → ${res.status}: ${res.text.slice(0, 120)}`);
      }
      if (route.startsWith("/fortnite/api/cloudstorage/system")) {
        const noHotfix = build >= 9.4 && build <= 10.4;
        report(noHotfix ? res.status === 404 : res.status === 200, `${version}: hotfix files ${noHotfix ? "none on purpose (404)" : "there (200)"} → ${res.status}`);
      }
      if (route.startsWith("/fortnite/api/calendar/v1/timeline") && res.status === 200) {
        const state = res.json().channels?.["client-events"]?.states?.at(-1)?.state ?? {};
        report(state.seasonNumber === season, `${version}: season detected (${state.seasonNumber})`);
      }
    }
    report(serverErrors === 0, `${version}: no 5xx answers (${serverErrors})`);
  }

  // Nothing may crash without a User-Agent (tools, browsers)
  const bare = await request("GET", `${base}/fortnite/api/storefront/v2/catalog`, "");
  report(bare.status < 500, `no User-Agent: shop answers without 5xx (${bare.status})`);
  const noBucket = await request("GET", `${base}/fortnite/api/game/v2/matchmakingservice/ticket/player/x`, "");
  report(noBucket.status < 500, `no bucketId: matchmaking ticket without 5xx (${noBucket.status})`);
} catch (err) {
  results.fail++;
  console.log(`  FAIL  ${err.stack ?? err}`);
} finally {
  child.kill("SIGKILL");
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${results.ok} OK, ${results.fail} FAILED`);
process.exit(results.fail ? 1 : 0);
