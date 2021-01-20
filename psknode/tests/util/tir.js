/**
 * Test Infrastructure Runner
 *
 */
const path = require('path');
process.env.PSK_ROOT_INSTALATION_FOLDER = path.join(__dirname, "../../../");

require(path.resolve(path.join(process.env.PSK_ROOT_INSTALATION_FOLDER, "psknode/bundles/pskWebServer.js")));

const os = require('os');
const fs = require('fs');
const pskPath = require("swarmutils").path;

const createKey = function (name) {
    let parsed = '' + name;
    parsed.replace(/^[A-Za-z0-9 ]+/g, ' ');
    return parsed
        .split(' ')
        .map((word, idx) =>
            idx === 0
                ? word.toLocaleLowerCase()
                : word.substr(0, 1).toLocaleUpperCase() + word.toLowerCase().substr(1)
        )
        .join('');
};

function createConstitutionFromSources(sources, options, callback) {
    const child_process = require('child_process');
    const path = require('path');
    const fs = require('fs');

    let pskBuildPath = path.resolve(path.join(__dirname, '../../psknode/bin/scripts/pskbuild.js'));
    if (typeof process.env.PSK_ROOT_INSTALATION_FOLDER !== "undefined") {
        pskBuildPath = path.resolve(path.join(process.env.PSK_ROOT_INSTALATION_FOLDER, 'psknode/bin/scripts/pskbuild.js'));
    }

    let internalOptions = {
        constitutionName: 'domain',
        outputFolder: null,
        cleanupTmpDir: true
    };

    if (typeof sources === 'string') {
        sources = [sources];
    }

    if (typeof options === 'function') {
        callback = options;
    } else if (typeof options === 'string') {
        internalOptions.outputFolder = options;
    } else if (typeof options === 'object') {
        Object.assign(internalOptions, options);
    }

    let sourcesNames = [];
    let sourcesPaths = [];

    if (sources && sources.length && sources.length > 0) {
        sourcesNames = sources.map(source => path.basename(source));
        sourcesPaths = sources.map(source => path.dirname(source));
    }

    sourcesNames = sourcesNames.join(',');
    sourcesPaths = sourcesPaths.join(',');

    const projectMap = {
        [internalOptions.constitutionName]: {"deps": sourcesNames, "autoLoad": true},
    };

    const dc = require("double-check");
    dc.createTestFolder('PSK_DOMAIN-', (err, tmpFolder) => {
        if (err) {
            return callback(err);
        }

        const projectMapPath = path.join(tmpFolder, 'projectMap.json');
        fs.writeFile(projectMapPath, JSON.stringify(projectMap), 'utf8', (err) => {
            if (err) {
                return callback(err);
            }

            let outputFolder = null;

            if (internalOptions.outputFolder) {
                outputFolder = internalOptions.outputFolder;
            } else {
                internalOptions.cleanupTmpDir = false;
                outputFolder = tmpFolder;
            }

            child_process.exec(`node ${pskBuildPath} --projectMap=${projectMapPath} --source=${sourcesPaths} --output=${outputFolder} --input=${tmpFolder}`, (err) => {
                if (err) {
                    return callback(err);
                }

                callback(undefined, path.join(outputFolder, `${internalOptions.constitutionName}.js`));

                if (internalOptions.cleanupTmpDir) {
                    fs.rmdir(tmpFolder, {recursive: true}, (err) => {
                        if (err) {
                            console.warn(`Failed to delete temporary folder "${tmpFolder}"`);
                        }
                    });
                }
            });
        });
    });
}

function createConstitution(prefix, describer, options, constitutionSourcesFolder, callback) {
    constitutionSourcesFolder = constitutionSourcesFolder || [];

    if (typeof constitutionSourcesFolder === 'string') {
        constitutionSourcesFolder = [constitutionSourcesFolder];
    }

    const contents = buildConstitutionFromDescription(describer, options);

    if (contents && contents !== '') {
        const tempConstitutionFolder = path.join(prefix, 'tmpConstitution');
        const file = path.join(tempConstitutionFolder, 'index.js');

        fs.mkdirSync(tempConstitutionFolder, {recursive: true});
        fs.writeFileSync(file, contents);
        constitutionSourcesFolder.push(tempConstitutionFolder);
    }

    //console.log('[TIR] Will construct constitution from', constitutionSourcesFolder);
    createConstitutionFromSources(constitutionSourcesFolder, prefix, callback);
}


function whenAllFinished(array, handler, callback) {
    let tasksLeft = array.length;

    if (tasksLeft === 0) {
        callback();
    }

    for (const task of array) {
        handler(task, (err) => {
            tasksLeft--;

            if (err) {
                tasksLeft = -1;
                return callback(err);
            }

            if (tasksLeft === 0) {
                callback(undefined);
            }
        });
    }
}

const Tir = function () {
    const pskApiHub = require('apihub');
    const pingPongFork = require('../../core/utils/pingpongFork');
    const openDSU = require('opendsu');

    const domainConfigs = {};
    const rootFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'psk_'));

    let testerNode = null;
    let virtualMQNode = null;
    let virtualMQPort = null;
    let zeroMQPort = null;

    /**
     * Adds a domain to the configuration, in a fluent way.
     * Does not launch anything, just stores the configuration.
     *
     * @param {string} domainName The name of the domain
     * @param {array} agents The agents to be inserted
     * @param {string} constitutionSourceFolder
     * @param bundlesSourceFolder
     * @returns SwarmDescriber
     */
    this.addDomain = function (domainName, agents, constitutionSourceFolder, bundlesSourceFolder) {
        let workspace = path.join(rootFolder, 'nodes', createKey(domainName));
        domainConfigs[domainName] = {
            name: domainName,
            agents,
            /*constitution: {},*/
            constitutionSourceFolder,
            bundlesSourceFolder: bundlesSourceFolder || path.resolve(path.join(__dirname, '../../bundles')),
            workspace: workspace,
            blockchain: path.join(workspace, 'conf')
        };
    };

    /**
     * Launches all the configured domains.
     *
     * @param {number|function} tearDownAfter The number of milliseconds the TIR will tear down, even if the test fails. If missing, you must call tearDown
     * @param {function} callable The callback
     */
    this.launch = (tearDownAfter, callable) => {
        if (callable === undefined && tearDownAfter.call) {
            callable = tearDownAfter;
            tearDownAfter = null;
        }

        if (testerNode !== null) {
            throw new Error('Test node already launched!');
        }

        if (virtualMQNode !== null) {
            throw new Error('VirtualMQ node already launched!');
        }

        console.info('[TIR] setting working folder root', rootFolder);

        const assert = require("double-check").assert;
        assert.addCleaningFunction(() => {
            this.tearDown(0);
        });

        launchVirtualMQNode(100, rootFolder, (err, vmqPort) => {
            if (err) {
                throw err;
            }

            virtualMQPort = vmqPort;
            $$.BDNS.addConfig("default", {
                endpoints: [
                    {
                        endpoint: `http://localhost:${virtualMQPort}`,
                        type: 'brickStorage'
                    },
                    {
                        endpoint: `http://localhost:${virtualMQPort}`,
                        type: 'anchorService'
                    }
                ]
            })
            $$.BDNS.addConfig("predefined", {
                endpoints: [
                    {
                        endpoint: `http://localhost:${virtualMQPort}`,
                        type: 'brickStorage'
                    },
                    {
                        endpoint: `http://localhost:${virtualMQPort}`,
                        type: 'anchorService'
                    }
                ]
            })

            if (Object.keys(domainConfigs).length === 0) { // no domain added
                prepareTeardownTimeout();
                callable(undefined, virtualMQPort);

                return;
            }

            launchLocalMonitor(callCallbackWhenAllDomainsStarted);

            fs.mkdirSync(path.join(rootFolder, 'nodes'), {recursive: true});

            const fakeDomainFile = path.join(rootFolder, 'domain.js');
            fs.writeFileSync(fakeDomainFile, "console.log('domain.js loaded.')");

            const defaultConstitutionBundlesPath = [
                path.resolve(path.join(process.env.PSK_ROOT_INSTALATION_FOLDER, "psknode/bundles/pskruntime.js")),
                path.resolve(path.join(process.env.PSK_ROOT_INSTALATION_FOLDER, "psknode/bundles/edfsBar.js")),
                path.resolve(path.join(process.env.PSK_ROOT_INSTALATION_FOLDER, "psknode/bundles/blockchain.js")),
                path.resolve(path.join(process.env.PSK_ROOT_INSTALATION_FOLDER, "psknode/bundles/pskWebServer.js")),
                fakeDomainFile
            ];

            EDFS.createDSU("Bar", (err, launcherBar) => {
                if (err) {
                    throw err;
                }

                launcherBar.load((err) => {
                    if (err) {
                        throw err;
                    }
                    launcherBar.addFiles(defaultConstitutionBundlesPath, openDSU.constants.CONSTITUTION_FOLDER, (err) => {
                        if (err) {
                            throw err;
                        }

                        launcherBar.getKeySSI((err, launcherKeySSI) => {
                            if (err) {
                                throw err;
                            }
                            const dossier = require("dossier");

                            dossier.load(launcherKeySSI, "TIR_AGENT_IDENTITY", (err, csbHandler) => {
                                if (err) {
                                    throw err;
                                }

                                global.currentHandler = csbHandler;
                                whenAllFinished(Object.values(domainConfigs), this.buildDomainConfiguration, (err) => {
                                    if (err) {
                                        throw err;
                                    }

                                    const seed = launcherKeySSI;

                                    testerNode = pingPongFork.fork(
                                        path.resolve(path.join(__dirname, "../../core/launcher.js")),
                                        [seed, rootFolder],
                                        {
                                            stdio: 'inherit',
                                            env: {
                                                PSK_PUBLISH_LOGS_ADDR: `tcp://127.0.0.1:${zeroMQPort}`
                                            }
                                        }
                                    );

                                    initializeSwarmEngine(virtualMQPort);
                                    prepareTeardownTimeout();
                                });
                            });
                        });
                    });
                })
            });
        });

        let domainsLeftToStart = Object.keys(domainConfigs).length;

        function callCallbackWhenAllDomainsStarted() {
            domainsLeftToStart -= 1;

            if (domainsLeftToStart === 0) {
                callable(undefined, virtualMQPort);
            }
        }

        let prepareTeardownTimeout = () => {
            setTimeout(() => {
                if (tearDownAfter !== null) {
                    setTimeout(() => this.tearDown(1), tearDownAfter);
                }
            }, 1000);
        }
    };

    function launchVirtualMQNode(maxTries, storageFolder, callback) {

        if (typeof storageFolder === "function") {
            callback = storageFolder;
            storageFolder = maxTries;
            maxTries = 100;
        }

        if (typeof maxTries === "function") {
            callback = maxTries;
            storageFolder = rootFolder;
            maxTries = 100;
        }

        const virtualMQPort = getRandomPort();
        process.env.vmq_channel_storage = storageFolder;
        virtualMQNode = pskApiHub.createInstance(virtualMQPort, storageFolder, err => {
            if (err) {

                if (maxTries === 0) {
                    throw err;
                }

                launchVirtualMQNode(maxTries - 1, storageFolder, callback);
                return
            }

            const opendsu = require("opendsu");
            const consts = opendsu.constants;
            const system = opendsu.loadApi("system");
            const nodeUrl = `http://localhost:${virtualMQPort}`;

            system.setEnvironmentVariable(consts.BDNS_ROOT_HOSTS, nodeUrl);
            process.env[consts.BDNS_ROOT_HOSTS] = nodeUrl;
            const bdns = {
                "default": {
                    "replicas": [],
                    "brickStorages": [
                        nodeUrl
                    ],
                    "anchoringServices": [
                        nodeUrl
                    ]
                },
                "predefined": {
                    "replicas": [],
                    "brickStorages": [
                        nodeUrl
                    ],
                    "anchoringServices": [
                        nodeUrl
                    ]
                }
            }

            storeDBNS(storageFolder, bdns, (err)=>{
                if(err){
                    return callback(err);
                }
               /* if (!$$.securityContext) {
                    $$.securityContext = require("psk-security-context").createSecurityContext();
                }

                $$.securityContext.generateIdentity((err, agentId) => {
                    if (err) {
                        return callback(err);
                    }*/

                    callback(undefined, virtualMQPort);
                /*});*/
            });

        });
    }

    function storeDBNS(rootFolder, content, callback){
        const fsName = "fs";
        const fs = require(fsName);

        const pathName = "path";
        const path = require(pathName);

        if(typeof content === "object"){
            content = JSON.stringify(content);
        }

        let path2Folder= path.join(rootFolder, "external-volume/config");
        //we define the PSK_CONFIG_LOCATION according to our test folder structure
        process.env.PSK_CONFIG_LOCATION = path2Folder;

        fs.mkdir(path2Folder, { recursive: true }, (err) => {
            if (err) {
                return callback(err);
            }
            fs.writeFile(path.join(path2Folder, "bdns.hosts"), content, callback);
        });

    }

    this.launchVirtualMQNode = launchVirtualMQNode;
    this.launchApiHubTestNode = launchVirtualMQNode;

    function launchLocalMonitor(maxTries, onBootMessage) {
        if (typeof maxTries === 'function') {
            onBootMessage = maxTries;
            maxTries = 100;
        }

        if (typeof maxTries !== 'number' || maxTries < 0) {
            maxTries = 100;
        }

        const zeromqName = 'zeromq';
        const zmq = require(zeromqName);
        const zmqReceiver = zmq.createSocket('sub');

        zmqReceiver.subscribe('events.status.domains.boot');
        zmqReceiver.on('message', onBootMessage);

        let portFound = false;

        while (!portFound && maxTries > 0) {
            zeroMQPort = getRandomPort();
            maxTries -= 1;
            try {
                zmqReceiver.bindSync(`tcp://127.0.0.1:${zeroMQPort}`);
                portFound = true;
            } catch (e) {
                console.log(e);
            } // port not found yet
        }

        if (!portFound) {
            throw new Error('Could not find a free port for zeromq');
        }

        console.log('[TIR] zeroMQ bound to address', `tcp://127.0.0.1:${zeroMQPort}`);

    }

    function initializeSwarmEngine(port) {
        const se = require('swarm-engine');
        try {
            se.initialise();
        } catch (err) {
            //
        }

        const powerCordToDomain = new se.SmartRemoteChannelPowerCord([`http://127.0.0.1:${port}/`]);
        $$.swarmEngine.plug("*", powerCordToDomain);

    }

    function getRandomPort() {
        const min = 9000;
        const max = 65535;
        return Math.floor(Math.random() * (max - min) + min);
    }

    /**
     * Builds the config for a node.
     *
     * @param {object} domainConfig The domain configuration stored by addDomain
     * @param callback
     */
    this.buildDomainConfiguration = (domainConfig, callback) => {
        console.info('[TIR] domain ' + domainConfig.name + ' in workspace', domainConfig.workspace);

        fs.mkdirSync(domainConfig.workspace, {recursive: true});

        getConstitutionSeed((err, constitutionSeed) => {
            if (err) {
                return callback(err);
            }

            const zeroMQPort = getRandomPort();
            const communicationInterfaces = {
                system: {
                    virtualMQ: `http://127.0.0.1:${virtualMQPort}`
                    //zeroMQ: `tcp://127.0.0.1:${zeroMQPort}`
                }
            };

            global.currentHandler.startTransaction("Domain", "add", domainConfig.name, "system", domainConfig.workspace, constitutionSeed)
                .onReturn((err) => {
                    if (err) {
                        return callback(err);
                    }

                    if (domainConfig.agents && Array.isArray(domainConfig.agents) && domainConfig.agents.length > 0) {

                        const dossier = require("dossier");
                        dossier.load(constitutionSeed, "TIR_AGENT_IDENTITY", (err, csbHandler) => {
                            if (err) {
                                return callback(err);
                            }

                            let transactionsLeft = domainConfig.agents.length + 1;

                            console.info('[TIR] domain ' + domainConfig.name + ' starting defining agents...');

                            domainConfig.agents.forEach(agentName => {
                                console.info('[TIR] domain ' + domainConfig.name + ' agent', agentName);
                                csbHandler.startTransaction("Agents", "add", agentName, "public_key")
                                    .onReturn(maybeCallCallback);
                            });

                            csbHandler.startTransaction('DomainConfigTransaction', 'add', domainConfig.name, communicationInterfaces)
                                .onReturn(maybeCallCallback);

                            function maybeCallCallback(err) {
                                if (err) {
                                    transactionsLeft = -1;
                                    return callback(err);
                                }

                                transactionsLeft -= 1;

                                if (transactionsLeft === 0) {
                                    callback();
                                }
                            }
                        });
                    } else {
                        callback();
                    }
                })
        });

        function getConstitutionSeed(callback) {
            const constitutionBundles = [domainConfig.bundlesSourceFolder];
            //console.log("constitutionBundles", constitutionBundles);

            deployConstitutionCSB(constitutionBundles, domainConfig.name, (err, archive) => {
                if (err) {
                    return callback(err);
                }

                buildConstitution(domainConfig.constitutionSourceFolder, archive, (err) => {
                    if (err) {
                        return callback(err);
                    }
                    archive.getKeySSI((err, keySSI) => {
                        callback(err, keySSI);
                    });
                });
            });
        }

        function deployConstitutionCSB(constitutionPaths, domainName, callback) {

            if (typeof domainName === "function" && typeof callback === "undefined") {
                callback = domainName;
                domainName = "";
            }

            EDFS.createDSU("Bar", (err, constitutionArchive) => {
                if (err) {
                    return callback(err);
                }
                const lastHandler = (err) => {
                    if (err) {
                        return callback(err);
                    }

                    callback(undefined, constitutionArchive);
                };

                const __addNext = (index = 0) => {
                    constitutionArchive.load((err) => {
                        if (err) {
                            return lastHandler(err);
                        }

                        if (index >= constitutionPaths.length) {

                            if (domainName !== "") {
                                constitutionArchive.writeFile(openDSU.constants.DOMAIN_IDENTITY_FILE, domainName, lastHandler)
                            } else {
                                lastHandler();
                            }

                            return;
                        }

                        const currentPath = constitutionPaths[index];
                        constitutionArchive.addFolder(currentPath, pskPath.join(openDSU.constants.CODE_FOLDER, openDSU.constants.CONSTITUTION_FOLDER), (err) => {
                            if (err) {
                                return callback(err);
                            }

                            __addNext(index + 1);
                        });
                    })
                };
                __addNext();
            });
        }

        function getConstitutionFile(callback) {
            createConstitution(domainConfig.workspace, domainConfig.constitution, undefined, domainConfig.constitutionSourceFolder, callback);
        }
    };

    this.getDomainConfig = domainName => {
        return domainConfigs[domainName];
    };

    /**
     * Tears down all the nodes
     *
     * @param exitStatus The exit status, to exit the process.
     */
    this.tearDown = exitStatus => {
        console.info('[TIR] Tearing down...');
        if (testerNode) {
            console.info('[TIR] Killing node', testerNode.pid);
            try {
                process.kill(testerNode.pid);
            } catch (e) {
                console.info('[TIR] Node already killed', testerNode.pid);
            }
            testerNode = null;
        }

        if (virtualMQNode) {
            console.log('[TIR] Killing VirtualMQ node', virtualMQNode.pid);
            try {
                process.kill(virtualMQNode.pid)
            } catch (e) {
                console.info('[TIR] VirtualMQ node already killed', virtualMQNode.pid);
            }
        }

        setTimeout(() => {
            try {
                console.info('[TIR] Removing temporary folder', rootFolder);
                fs.rmdirSync(rootFolder, {recursive: true});
                console.info('[TIR] Temporary folder removed', rootFolder);
            } catch (e) {
                //just avoid to display error on console
            }

            /*if (exitStatus !== undefined) {
                process.exit(exitStatus);
            }*/
        }, 100);
    };

    function buildConstitution(path, targetArchive, callback) {
        process.env.PSK_ROOT_INSTALATION_FOLDER = require("path").join(__dirname, "../../../");
        createConstitutionFromSources(path, (err, fileName) => {
            if (err) {
                return callback(err);
            }
            targetArchive.addFile(fileName, pskPath.join(openDSU.constants.CONSTITUTION_FOLDER, "domain.js"), callback);
        });
    }

    this.buildConstitution = buildConstitution;
};

module.exports = new Tir();
