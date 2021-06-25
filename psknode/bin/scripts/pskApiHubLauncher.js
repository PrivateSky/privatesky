const TAG = "API-HUB";

let path = require("path");

require("../../core/utils/pingpongFork").enableLifeLine({
    handleExceptionEvents: ["SIGINT", "SIGUSR1", "SIGUSR2", "SIGTERM", "SIGHUP"]
});
require(path.join(__dirname, '../../bundles/pskWebServer.js'));

path = require("swarmutils").path;
const API_HUB = require('apihub');
const fs = require('fs');
if (!process.env.PSK_ROOT_INSTALATION_FOLDER) {
    process.env.PSK_ROOT_INSTALATION_FOLDER = path.resolve("." + __dirname + "/../..");
}

if (!process.env.PSK_CONFIG_LOCATION) {
    process.env.PSK_CONFIG_LOCATION = "./conf";
}

function startServer() {
    let sslConfig = undefined;
    let config = API_HUB.getServerConfig();
    console.log(`[${TAG}] Using certificates from path`, path.resolve(config.sslFolder));

    try {
        sslConfig = {
            cert: fs.readFileSync(path.join(config.sslFolder, 'server.cert')),
            key: fs.readFileSync(path.join(config.sslFolder, 'server.key'))
        };
    } catch (e) {
        console.log(`[${TAG}] No certificates found, PskWebServer will start using HTTP`);
    }

    const listeningPort = Number.parseInt(config.port);
    const rootFolder = path.resolve(config.storage);

    API_HUB.createInstance(listeningPort, rootFolder, sslConfig, (err) => {
        if (err) {
            console.error(err);
        }
        console.log(`\n[${TAG}] listening on port :${listeningPort} and ready to receive requests.\n`);
    });
}

let retryTimeout = 100;
function retry() {
    setTimeout(() => {
        retryTimeout = (retryTimeout * 2) % (10 * 60 * 1000);
        startServer();
    }, retryTimeout);
}

// If the apihub port is already in use, retry starting the server
// For other kind of exceptions exit with code 1
process.on('uncaughtException', (e) => {
    // Handle `throw null` && `throw undefined`
    if (typeof e !== 'object' || !e) {
        e = new Error(e);
    }

    if (e.code === 'EADDRINUSE') {
        console.log(`Port not available. Retrying in ${retryTimeout / 1000}s`);
        return retry();
    }

    console.log(`Uncaught exception`, e);
    process.exit(1);
})

startServer();
