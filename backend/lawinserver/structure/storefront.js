const Express = require("express");
const niobium = require("./niobium.js"); // NIOBIUM: paths, ports and game server target from src/main.ts
const express = Express.Router();
const functions = require("./functions.js");
const keychain = niobium.json("responses/keychain.json"); // NIOBIUM: path via niobium.js (data folder/resources)

express.get("/fortnite/api/storefront/v2/catalog", async (req, res) => {
    if ((req.headers["user-agent"] || "").includes("2870186")) { // NIOBIUM: no crash without a User-Agent
        return res.status(404).end();
    }

    var catalog = functions.getItemShop();
    const memory = functions.GetVersionInfo(req);

    if (memory.build >= 30.10) {
        catalog = JSON.parse(JSON.stringify(catalog).replace(/"Normal"/g, '"Size_1_x_2"'));
    }
    if (memory.build >= 30.20) {
        catalog = JSON.parse(JSON.stringify(catalog).replace(/Game\/Items\/CardPacks\//g, 'SaveTheWorld/Items/CardPacks/'));
    }

    res.json(catalog);
})

express.get("/fortnite/api/storefront/v2/keychain", async (req, res) => {
    res.json(keychain)
})

express.get("/catalog/api/shared/bulk/offers", async (req, res) => {
    res.json({});
})

module.exports = express;