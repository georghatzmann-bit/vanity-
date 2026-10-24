const Express = require("express");
const vanity = require("./vanity.js"); // VANITY: Pfade, Ports und Game-Server-Ziel aus src/main.ts
const express = Express.Router();
const fs = require("fs");
const privacy = vanity.json("responses/privacy.json"); // VANITY: Pfad über vanity.js (Daten-Ordner/Ressourcen)

express.get("/fortnite/api/game/v2/privacy/account/:accountId", async (req, res) => {
    privacy.accountId = req.params.accountId;

    res.json(privacy);
})

express.post("/fortnite/api/game/v2/privacy/account/:accountId", async (req, res) => {
    privacy.accountId = req.params.accountId;
    privacy.optOutOfPublicLeaderboards = req.body.optOutOfPublicLeaderboards;

    vanity.writeFile("responses/privacy.json", JSON.stringify(privacy, null, 2)); // VANITY: Pfad über vanity.js (Daten-Ordner/Ressourcen)

    res.json(privacy);
    res.end();
})

module.exports = express;