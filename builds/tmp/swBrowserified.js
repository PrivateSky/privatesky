if(typeof $$ === "undefined"){
    $$ = {};
}
$$.browserRuntime = true;
require("../../modules/overwrite-require");
require("../../modules/callflow/standardGlobalSymbols");
require("./swBrowserified_intermediar");

