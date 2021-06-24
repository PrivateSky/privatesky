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

// If the apihub port is already in use, exit with exit code 2
// so that the service launcher will restart the process.
// For other kind of exception use exit code 1 so that the
// service launcher won't restart the process
process.on('uncaughtException', (e) => {
    // Handle `throw null` && `throw undefined`
    if (typeof e !== 'object' || !e) {
        e = new Error(e);
    }

    let exitCode = 1;
    if (e.code === 'EADDRINUSE') {
        exitCode = 2;
    }
    console.log(`Unhandled exception:`, e);
    process.exit(exitCode);
})

startServer();
