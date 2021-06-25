const path = require('path');
const configFileName = "server.json";

const defaultConfig = {
    services: ["psk_api_hub"],
    maxTimeout: 10 * 60 * 1000, // 10 minutes
    psk_api_hub:{
        module: "pskApiHubLauncher.js",
        restartPolicy: {
            onError: true, // on spawn error
            onExit: false
        }
    },
    domainLauncher:{
        module: "../../core/launcher.js",
        configBuilder: "../../coreConfigBuilder",
        autoConfig: true
    }
};
const TAG = "ServiceLauncher";

process.env.PSK_ROOT_INSTALATION_FOLDER = path.resolve(path.join(__dirname, "../../../"));
if (typeof process.env.PSK_CONFIG_LOCATION === "undefined") {
    process.env.PSK_CONFIG_LOCATION = path.join(process.env.PSK_ROOT_INSTALATION_FOLDER, "conf");
    console.log(`[${TAG}] process.env.PSK_CONFIG_LOCATION set to <${process.env.PSK_CONFIG_LOCATION}>`);
}

let config = defaultConfig;
const configFile = path.join(process.env.PSK_CONFIG_LOCATION, configFileName);
try{
    let globalConfig = require(configFile);
    config = Object.assign(config, globalConfig.serviceLauncher);
    console.log(`[${TAG}] Configuration file loaded.`);
}catch(err){
    if(err.code !== "MODULE_NOT_FOUND"){
        console.log(`[${TAG}]`, 'Error during config loading. Default config will be used.');
        console.log(err);
    }
    console.log(`[${TAG}]`, `Not able to find file <${configFile}>`)
}

const max_timeout = config.maxTimeout;
const restartDelays = {};

const pingFork = require("../../core/utils/pingpongFork").fork;

const shouldRestart = true;
const forkedProcesses = {};

function startProcess(filePath, processOptions) {
    const args = processOptions.args;
    const options = processOptions.options
    const restartPolicy = processOptions.restartPolicy || {
        onError: shouldRestart,
        onExit: shouldRestart
    }

    console.log(`[${TAG}] Starting a new process using <${filePath}>`);
    forkedProcesses[filePath] = pingFork(filePath, args, options);

    console.log(`[${TAG}]`, `Process with PID=[${forkedProcesses[filePath].pid}] was spawned.`);

    function restartWithDelay(filePath){
        let timeout = restartDelays[filePath] || 100;
        console.log(`Process will restart in ${timeout} ms ...`);
        setTimeout(()=>{
            restartDelays[filePath] = (timeout * 2) % max_timeout;
            startProcess(filePath, processOptions);
        }, timeout);
    }

    function errorHandler(filePath) {
        return function (error) {
            console.log(`\x1b[31mException caught on spawning file ${filePath} `, error ? error : "", "\x1b[0m"); //last string is to reset terminal colours
            if (restartPolicy.onError) {
                restartWithDelay(filePath);
            }
        }
    }

    function exitHandler(filePath) {
        return function () {
            console.log(`\x1b[33mExit caught on spawned file ${filePath}`, "\x1b[0m"); //last string is to reset terminal colours
            if (restartPolicy.onExit) {
                restartWithDelay(filePath);
            }
        }
    }

    forkedProcesses[filePath].on('error', errorHandler(filePath));
    forkedProcesses[filePath].on('exit', exitHandler(filePath));
}

for(let i=0; i<config.services.length; i++){
    let serviceName = config.services[i];
    let serviceConfig = config[serviceName];
    startProcess(path.join(__dirname, serviceConfig.module), serviceConfig);
}
