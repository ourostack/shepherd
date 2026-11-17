#!/usr/bin/env node
// The X-ray's guard: exits 0 only when the home is a temporary one and holds the fixture's marker, with the pretend app on
// loopback. Anything else exits 2 before the X-ray calls the CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const { HOME, RUNNER_TEMP = '' } = process.env;
const refuse = (why) => { console.error(`assert-mock: refused: ${why}`); process.exit(2); };

const tmpRoots = [os.tmpdir(), RUNNER_TEMP].filter(Boolean).map((p) => path.resolve(p));
if (!HOME || !tmpRoots.some((root) => path.resolve(HOME).startsWith(root + path.sep))) refuse(`HOME (${HOME}) is not under a temporary folder`);
let marker;
try { marker = JSON.parse(fs.readFileSync(path.join(HOME, '.shepherd-xray-fixture'), 'utf8')); } catch { refuse(`${HOME} has no .shepherd-xray-fixture: start scripts/xray-fixture.mjs on it first`); }
const port = Number(fs.readFileSync(path.join(HOME, '.copilot', 'run', 'ws.port'), 'utf8'));
if (port !== marker.port) refuse('the app socket is not the fixture\'s');
await new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(); });
  socket.on('error', () => refuse(`nothing answers on 127.0.0.1:${port}`));
});
console.log('assert-mock: the home is temporary and the app is the fixture, on loopback');
