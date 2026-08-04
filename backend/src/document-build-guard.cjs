const childProcess = require('node:child_process');
const dgram = require('node:dgram');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const workerThreads = require('node:worker_threads');
const { syncBuiltinESMExports } = require('node:module');

function blocked(capability) {
  return function denyCapability() {
    throw new Error(`${capability} is disabled in the document build sandbox`);
  };
}

for (const name of ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync']) {
  childProcess[name] = blocked('child processes');
}
for (const name of ['connect', 'createConnection', 'createServer']) {
  net[name] = blocked('network access');
}
tls.connect = blocked('network access');
dgram.createSocket = blocked('network access');
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'reverse']) {
  dns[name] = blocked('network access');
}
for (const module of [http, https]) {
  module.get = blocked('network access');
  module.request = blocked('network access');
  module.createServer = blocked('network access');
}
workerThreads.Worker = blocked('worker threads');

globalThis.fetch = blocked('network access');
globalThis.WebSocket = class DisabledWebSocket {
  constructor() { throw new Error('network access is disabled in the document build sandbox'); }
};

syncBuiltinESMExports();
