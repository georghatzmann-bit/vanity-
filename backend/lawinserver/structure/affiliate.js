const Express = require("express");
const vanity = require("./vanity.js"); // VANITY: Pfade, Ports und Game-Server-Ziel aus src/main.ts
const express = Express.Router();

express.get("/affiliate/api/public/affiliates/slug/:slug", async (req, res) => {
    const SupportedCodes = vanity.json("responses/SAC.json"); // VANITY: Pfad über vanity.js (Daten-Ordner/Ressourcen)
    var ValidCode = false;

    SupportedCodes.forEach(code => {
        if (req.params.slug.toLowerCase() == code.toLowerCase()) {
            ValidCode = true;
            return res.json({
                "id": code,
                "slug": code,
                "displayName": code,
                "status": "ACTIVE",
                "verified": false
            });
        }
    })

    if (ValidCode == false) {
        res.status(404);
        res.json({});
    }
})

module.exports = express;