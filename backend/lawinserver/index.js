const Express = require("express");
const fs = require("fs");
const path = require("path");
const cookieParser = require("cookie-parser");
const vanity = require("./structure/vanity.js"); // VANITY: Pfade, Ports und Game-Server-Ziel aus src/main.ts

// VANITY: Der Aufbau der Express-App steckt jetzt in createApp(), damit src/main.ts die App
// einbinden kann. listen() auf beide Ports, der Start von xmpp.js und das Anlegen der Ordner
// (früher %LOCALAPPDATA%\LawinServer) passieren in src/main.ts.
function createApp() { // VANITY
const express = Express();

express.use(Express.json());
express.use(Express.urlencoded({ extended: true }));
express.use(Express.static(vanity.file("public"))); // VANITY: Ressourcen-Ordner statt Arbeitsordner
express.use(cookieParser());

express.use(require("./structure/party.js"));
express.use(require("./structure/discovery.js"))
express.use(require("./structure/privacy.js"));
express.use(require("./structure/timeline.js"));
express.use(require("./structure/user.js"));
express.use(require("./structure/contentpages.js"));
express.use(require("./structure/friends.js"));
express.use(require("./structure/main.js"));
express.use(require("./structure/storefront.js"));
express.use(require("./structure/version.js"));
express.use(require("./structure/lightswitch.js"));
express.use(require("./structure/affiliate.js"));
express.use(require("./structure/matchmaking.js"));
express.use(require("./structure/cloudstorage.js"));
express.use(require("./structure/mcp.js"));

// VANITY: express.listen(), require("./structure/xmpp.js") und das Anlegen von
// %LOCALAPPDATA%\LawinServer bzw. ./ClientSettings wurden nach src/main.ts verschoben.

// if endpoint not found, return this error
express.use((req, res, next) => {
    var XEpicErrorName = "errors.com.lawinserver.common.not_found";
    var XEpicErrorCode = 1004;

    res.set({
        'X-Epic-Error-Name': XEpicErrorName,
        'X-Epic-Error-Code': XEpicErrorCode
    });

    res.status(404);
    res.json({
        "errorCode": XEpicErrorName,
        "errorMessage": "Sorry the resource you were trying to find could not be found",
        "numericErrorCode": XEpicErrorCode,
        "originatingService": "any",
        "intent": "prod"
    });
});

return express; // VANITY
} // VANITY

module.exports = { createApp }; // VANITY
