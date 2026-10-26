const Express = require("express");
const niobium = require("./niobium.js"); // NIOBIUM: paths, ports and game server target from src/main.ts
const express = Express.Router();
const fs = require("fs");
const privacy = niobium.json("responses/privacy.json"); // NIOBIUM: path via niobium.js (data folder/resources)

express.get("/fortnite/api/game/v2/privacy/account/:accountId", async (req, res) => {
    privacy.accountId = req.params.accountId;

    res.json(privacy);
})

express.post("/fortnite/api/game/v2/privacy/account/:accountId", async (req, res) => {
    privacy.accountId = req.params.accountId;
    privacy.optOutOfPublicLeaderboards = req.body.optOutOfPublicLeaderboards;

    niobium.writeFile("responses/privacy.json", JSON.stringify(privacy, null, 2)); // NIOBIUM: path via niobium.js (data folder/resources)

    res.json(privacy);
    res.end();
})

module.exports = express;