// NIOBIUM: new file, not part of LawinServer.
// One place for everything Rift changes in LawinServer: data folder, resource folder,
// ports, bind address and the matchmaker's game server target.
// src/main.ts calls configure() BEFORE any other LawinServer module is loaded.
//
// LawinServer originally loaded/saved data like this:
//   read:  require("./../profiles/athena.json")      (relative to the module, cached by require)
//   write: fs.writeFileSync("./profiles/athena.json") (relative to the working folder)
// Rift replaces that with json("profiles/athena.json") and writeFile("profiles/athena.json", …).
// Both resolve the path with file(): writable files (WRITABLE) live in the data folder,
// everything else is only read and stays in the resource folder (next to dist/main.js).

const fs = require("fs");
const path = require("path");

// Paths relative to the LawinServer folder that LawinServer writes or that the user may edit.
// Folders end with "/". On the first start src/main.ts copies the bundled default files of
// these paths into the data folder.
const WRITABLE = [
    "profiles/",
    "Config/",
    "ClientSettings/",
    "responses/friendslist.json",
    "responses/friendslist2.json",
    "responses/privacy.json",
    "responses/Athena/SeasonData.json"
];

// Without configure() everything behaves like in the unchanged LawinServer folder.
const settings = {
    resourceDir: path.join(__dirname, ".."),
    dataDir: path.join(__dirname, ".."),
    bindAddress: "127.0.0.1",
    matchmakerPort: 80,
    gameServer: { ip: "127.0.0.1", port: 7777 }
};

function configure(options) {
    if (options.resourceDir) settings.resourceDir = options.resourceDir;
    if (options.dataDir) settings.dataDir = options.dataDir;
    if (options.bindAddress) settings.bindAddress = options.bindAddress;
    if (options.matchmakerPort) settings.matchmakerPort = options.matchmakerPort;
    if (options.gameServer) setGameServer(options.gameServer.ip, options.gameServer.port);
}

function setGameServer(ip, port) {
    settings.gameServer = { ip: String(ip), port: Number(port) };
}

// A single file/profile name without path parts (e.g. "athena", "DefaultEngine.ini").
function isSafeName(name) {
    return typeof name == "string" && /^[A-Za-z0-9_.-]+$/.test(name) && !name.includes("..");
}

function isWritable(rel) {
    const norm = rel.replace(/\\/g, "/");
    return WRITABLE.some((entry) => entry.endsWith("/")
        ? norm == entry.slice(0, -1) || norm.startsWith(entry)
        : norm == entry);
}

// Absolute path of a LawinServer file (rel like "profiles/athena.json").
// Throws for paths that lead out of the folder (e.g. profileId=../../x).
function file(rel) {
    if (typeof rel != "string" || rel.includes("\0") || path.isAbsolute(rel) || rel.split(/[\\/]+/).includes("..")) {
        throw new Error(`NIOBIUM: invalid data path ${JSON.stringify(rel)}`);
    }

    return path.join(isWritable(rel) ? settings.dataDir : settings.resourceDir, rel);
}

// Replacement for require("./../<rel>") for JSON files: same behaviour as require
// (read once, then always the same object; changes stay in memory).
const jsonCache = new Map();
function json(rel) {
    const abs = file(rel);

    if (!jsonCache.has(abs)) {
        jsonCache.set(abs, readJson(rel, abs));
    }

    return jsonCache.get(abs);
}

function parseJsonFile(abs) {
    let text = fs.readFileSync(abs, "utf8");
    if (text.charCodeAt(0) == 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
}

// A damaged file in the data folder (empty or cut off, e.g. copied over from an old Niobium
// install) must not stop the backend: it is kept as "<name>.broken" and the bundled default is used.
function readJson(rel, abs) {
    try {
        return parseJsonFile(abs);
    } catch (err) {
        const fallback = path.join(settings.resourceDir, rel);
        if (!isWritable(rel) || abs == fallback || !fs.existsSync(fallback) || err.code == "EACCES" || err.code == "EBUSY") throw err;

        const broken = `${abs}.broken`;
        try { fs.rmSync(broken, { force: true }); fs.renameSync(abs, broken); } catch (e) {}
        fs.copyFileSync(fallback, abs);
        console.log(`[Rift] ${abs} was damaged (${err.message}) – kept it as ${path.basename(broken)} and put the default file back`);
        return parseJsonFile(abs);
    }
}

// Replacement for fs.writeFileSync("./<rel>", data): writes to a temp file first and then renames
// it, so stopping in the middle of a write (e.g. the launcher closes the backend) never leaves
// half an athena.json behind.
function writeFile(rel, data) {
    const target = file(rel);
    const temp = `${target}.tmp`;

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, data);

    try {
        fs.renameSync(temp, target);
    } catch (err) {
        // e.g. Windows: the target is briefly locked by a virus scanner
        fs.writeFileSync(target, data);
        try { fs.unlinkSync(temp); } catch (err) {}
    }
}

module.exports = {
    WRITABLE,
    settings,
    configure,
    setGameServer,
    isSafeName,
    file,
    json,
    writeFile
};
