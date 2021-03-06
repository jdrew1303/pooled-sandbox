var Defaults = require('lodash.defaultsdeep');
var Posix = require('posix');
var Tripwire = require('tripwire');
var Vm = require('vm');


// Do a noop ever once in a while to make sure there is always an async op
// in the queue. This is a HACK to support tripwire in Node > 0.10.
var tripwireSupportTimeout;


process.on('message', onMessage);
process.on('uncaughtException', onUncaughtException);


var TRUSTED_APIS = {
    'JSON': JSON,
    'Promise': Promise,
    'console': console,
    'encodeURI': encodeURI,
    'encodeURIComponent': encodeURIComponent,
    'isNaN': isNaN,
    'parseInt': parseInt,
    'parseFloat': parseFloat,
    'setImmediate': setImmediate,
    'setInterval': setInterval,
    'setTimeout': setTimeout,
};


function createError(name, message, details) {
    var error = {
        name: name,
        message: message,
        fromSandbox: true,
    };
    
    for (var key in details) {
        error[key] = details[key];
    }
    
    return error;
}

function onMessage(message) {
    switch (message.action) {
        case 'configure': return onConfigure(message);
        case 'run': return onRun(message);
    }
    
    throw new Error('Received unexpected message');
}

function onConfigure(message) {
    var options = message.options;
    
    if (options.rlimit) {
        Object.keys(options.rlimit).forEach(function (resource) {
            var spec = options.rlimit[resource];
            var limit = typeof spec === 'number'
                ?   { soft: spec, hard: spec }
                :   spec;
            
            Posix.setrlimit(resource, limit);
        });
    }
    
    if (typeof options.uid === 'number') {
        process.setuid(options.uid);
    }
    
    if (typeof options.gid === 'number') {
        process.setgid(options.gid);
    }
    
    if (typeof options.chroot === 'string') {
        Posix.chroot(options.chroot);
    }
}

function onRun(message) {
    
    var code = message.code;
    var args = message.args || [];
    var globals = message.globals;
    var exports = {};
    var module = { exports: exports };
    
    var expose = typeof message.expose === 'undefined'
        ?   TRUSTED_APIS
        :   Array.isArray(message.expose)
            ?   message.expose.reduce(function (acc, expose) {
                    acc[expose] = TRUSTED_APIS[expose];
                    
                    return acc;
                }, {})
            :   message.expose;

    var tripwireTimeout = message.tripwireTimeout || 1000;
    
    // HACK: Ensure an async op is in the queue at the time of invoking Tripwire.
    tripwireSupportTimeout = setTimeout(function() {}, tripwireTimeout + 1);
    
    Tripwire.resetTripwire(tripwireTimeout, { timeout: tripwireTimeout });
    
    var sandboxGlobals = Defaults({
        exports: exports,
        module: module,
    }, expose, globals);
    var sandbox = Vm.createContext(sandboxGlobals);
    
    var wrappedCode = '(function(module, exports) { var ret = ' + code + '; return typeof module.exports !== "function" ? ret : module.exports })(module, exports);';
    
    var closure = Vm.runInContext(wrappedCode, sandbox, message.filename || 'sandbox.js');
    
    var func = typeof module.exports === 'function'
        ?   module.exports
        :   closure;
    
    if (typeof func !== 'function') {
        return onResult(createError('SandboxFatalError', 'Sandbox code must export or return a function'));
    }
    
    func.apply(null, args.concat([onResult]));
}

function onResult(err, data, cb) {
    process.send({
        err: err,
        data: Array.prototype.slice.call(arguments, 1),
    }, undefined, cb);
    
    Tripwire.clearTripwire();
}

function onUncaughtException(e) {
    var tripwireContext = Tripwire.getContext();
    
    if (!(e instanceof Error)) {
        e = new Error(e.message || e);
        
        Error.captureStackTrace(e, onUncaughtException);
    }
    
    e.isTripwire = typeof tripwireContext !== 'undefined';
    e.isUncaughtException = !e.isTripwire;
    
    // Capture the stack trace
    if (!e.isTripwire) {
        Object.defineProperty(e, 'stack', {
            enumerable: true,
            value: e.stack,
        });
    }
    
    typeof tripwireContext !== 'undefined'
        ?   onResult(createError('SandboxUnhandledError', 'Sandboxed code blocked the event loop for more than ' + tripwireContext.timeout + 'ms', e), onSent)
        :   onResult(createError('SandboxUnhandledError', 'Sandboxed code generated an unhandled exception: ' + e.message, e), onSent);
    
    function onSent() {
        clearTimeout(tripwireSupportTimeout);
        
        // An uncaught exception means the sandbox's state cannot be relied upon.
        process.exit(1);
    }
}
