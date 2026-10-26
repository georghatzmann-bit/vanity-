const Express = require("express");
const fs = require("fs");
const path = require("path");
const cookieParser = require("cookie-parser");
const niobium = require("./structure/niobium.js"); // NIOBIUM: paths, ports and game server target from src/main.ts

// NIOBIUM: the Express app is now built in createApp(), so src/main.ts can mount it.
// listen() on both ports, starting xmpp.js and creating the folders
// (formerly %LOCALAPPDATA%\LawinServer) happen in src/main.ts.
function createApp() { // NIOBIUM
const express = Express();

express.use(Express.json());
express.use(Express.urlencoded({ extended: true }));
express.use(Express.static(niobium.file("public"))); // NIOBIUM: resource folder instead of the working folder
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

// NIOBIUM: express.listen(), require("./structure/xmpp.js") and creating
// %LOCALAPPDATA%\LawinServer / ./ClientSettings moved to src/main.ts.

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

return express; // NIOBIUM
} // NIOBIUM

module.exports = { createApp }; // NIOBIUM
