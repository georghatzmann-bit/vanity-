// VANITY: Neue Datei, nicht Teil von LawinServer.
// Zentrale Stelle für alles, was Vanity an LawinServer anpasst: Daten-Ordner, Ressourcen-Ordner,
// Ports, Bind-Adresse und das Game-Server-Ziel des Matchmakers.
// src/main.ts ruft configure() auf, BEVOR ein anderes LawinServer-Modul geladen wird.
//
// LawinServer hat Daten ursprünglich so geladen/gespeichert:
//   lesen:     require("./../profiles/athena.json")      (relativ zum Modul, von require zwischengespeichert)
//   schreiben: fs.writeFileSync("./profiles/athena.json") (relativ zum Arbeitsordner)
// Vanity ersetzt das durch json("profiles/athena.json") und writeFile("profiles/athena.json", …).
// Beides löst den Pfad über file() auf: beschreibbare Dateien (WRITABLE) liegen im Daten-Ordner,
// alles andere wird nur gelesen und bleibt im Ressourcen-Ordner (neben dist/main.js).

const fs = require("fs");
const path = require("path");

// Pfade relativ zum LawinServer-Ordner, die LawinServer beschreibt oder die der Nutzer anpassen
// soll. Ordner enden mit "/". src/main.ts kopiert die mitgelieferten Standard-Dateien dieser
// Pfade beim ersten Start in den Daten-Ordner.
const WRITABLE = [
    "profiles/",
    "Config/",
    "ClientSettings/",
    "responses/friendslist.json",
    "responses/friendslist2.json",
    "responses/privacy.json",
    "responses/Athena/SeasonData.json"
];

// Ohne configure() verhält sich alles wie im unveränderten LawinServer-Ordner.
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

// Ein einzelner Datei-/Profilname ohne Pfadteile (z. B. "athena", "DefaultEngine.ini").
function isSafeName(name) {
    return typeof name == "string" && /^[A-Za-z0-9_.-]+$/.test(name) && !name.includes("..");
}

function isWritable(rel) {
    const norm = rel.replace(/\\/g, "/");
    return WRITABLE.some((entry) => entry.endsWith("/")
        ? norm == entry.slice(0, -1) || norm.startsWith(entry)
        : norm == entry);
}

// Absoluter Pfad zu einer LawinServer-Datei (rel wie "profiles/athena.json").
// Wirft bei Pfaden, die aus dem Ordner herausführen (z. B. profileId=../../x).
function file(rel) {
    if (typeof rel != "string" || rel.includes("\0") || path.isAbsolute(rel) || rel.split(/[\\/]+/).includes("..")) {
        throw new Error(`VANITY: invalid data path ${JSON.stringify(rel)}`);
    }

    return path.join(isWritable(rel) ? settings.dataDir : settings.resourceDir, rel);
}

// Ersatz für require("./../<rel>") bei JSON-Dateien: gleiches Verhalten wie require
// (einmal lesen, danach immer dasselbe Objekt; Änderungen bleiben im Speicher).
const jsonCache = new Map();
function json(rel) {
    const abs = file(rel);

    if (!jsonCache.has(abs)) {
        let text = fs.readFileSync(abs, "utf8");
        if (text.charCodeAt(0) == 0xFEFF) text = text.slice(1);
        jsonCache.set(abs, JSON.parse(text));
    }

    return jsonCache.get(abs);
}

// Ersatz für fs.writeFileSync("./<rel>", data): schreibt erst in eine Temp-Datei und benennt sie
// dann um, damit ein Abbruch mitten im Schreiben (z. B. Launcher beendet das Backend) keine halbe
// athena.json hinterlässt.
function writeFile(rel, data) {
    const target = file(rel);
    const temp = `${target}.tmp`;

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, data);

    try {
        fs.renameSync(temp, target);
    } catch (err) {
        // z. B. Windows: Ziel kurz von einem Virenscanner gesperrt
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
