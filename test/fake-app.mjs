// A pretend GitHub Copilot app for tests: a home folder (run/ws.port, run/ws.token) and a local WebSocket server that
// answers send_message, archive_workspace and archive_session the way the app does. Nothing here touches a real app.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { historyFile } from '../src/index.mjs';

const frame = (text) => {
  const b = Buffer.from(text);
  const head = b.length < 126 ? Buffer.from([0x81, b.length]) : Buffer.from([0x81, 126, b.length >> 8, b.length & 255]);
  return Buffer.concat([head, b]);
};

function* frames(buf) {
  let i = 0;
  while (i + 2 <= buf.length) {
    let len = buf[i + 1] & 127;
    let o = i + 2;
    if (len === 126) { len = buf.readUInt16BE(o); o += 2; }
    const mask = buf[i + 1] & 128 ? buf.subarray(o, o + 4) : null;
    if (mask) o += 4;
    if (o + len > buf.length) return;
    const p = Buffer.from(buf.subarray(o, o + len));
    if (mask) for (let k = 0; k < p.length; k++) p[k] ^= mask[k % 4];
    if ((buf[i] & 15) === 1) yield p.toString('utf8');
    i = o + len;
  }
}

// refuse: ids the app answers with an error. silent: ids it takes the message for but never confirms. turns: a send also
// writes the session's history (a user message, then a new turn 30 ms later), except for ids in drop, which never take a turn.
// reply(request) may answer any request with frames of its own (or null to fall through to the defaults below).
// push(frame) sends a frame to every connected client, as the app announces a question or plan.
export async function startFakeApp(home, { token = 'tok', refuse = [], silent = [], turns = false, drop = [], reply = null } = {}) {
  fs.mkdirSync(path.join(home, 'run'), { recursive: true });
  const received = [];
  const server = http.createServer();
  const open = new Set();
  server.on('upgrade', (req, socket) => {
    if (new URL(req.url, 'http://x').searchParams.get('token') !== token) { socket.destroy(); return; }
    const key = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('error', () => {});
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
    socket.write(frame(JSON.stringify({ type: 'server_hello' })));
    const say = (o) => socket.write(frame(JSON.stringify(o)));
    socket.on('data', (buf) => {
      if ((buf[0] & 15) === 8) { socket.destroy(); return; }
      for (const text of frames(buf)) {
        const m = JSON.parse(text);
        received.push(m);
        const own = reply?.(m);
        if (own) { for (const f of own) say(f); continue; }
        const id = m.session_id || m.workspace_id;
        if (refuse.includes(id)) { say({ type: 'error', request_id: m.request_id, message: `${id} is archived` }); continue; }
        if (silent.includes(id)) continue;
        if (m.type === 'send_message') {
          if (turns) takeTurn(home, id, m.prompt, !drop.includes(id));
          say({ type: 'session_message_sent', request_id: m.request_id, session_id: m.session_id });
        }
        if (m.type === 'archive_workspace') say({ type: 'workspace_archived', request_id: m.request_id, workspace_id: m.workspace_id });
        if (m.type === 'archive_session') say({ type: 'general_chat_sessions_changed' });
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(home, 'run', 'ws.port'), String(server.address().port));
  fs.writeFileSync(path.join(home, 'run', 'ws.token'), token);
  const push = (o) => { for (const s of open) s.write(frame(JSON.stringify(o))); };
  return { received, push, close: () => new Promise((r) => { for (const s of open) s.destroy(); server.close(r); }) };
}

function takeTurn(home, id, prompt, turnFollows) {
  const f = historyFile(home, id);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, `${JSON.stringify({ type: 'user.message', data: { content: prompt }, timestamp: new Date().toISOString() })}\n`);
  if (!turnFollows) return;
  setTimeout(() => {
    try { fs.appendFileSync(f, `${JSON.stringify({ type: 'assistant.turn_start', data: {}, timestamp: new Date().toISOString() })}\n`); } catch { /* the test folder is gone */ }
  }, 30);
}

// A session's history file with these events (type, data, at), for tests: at defaults to now.
export function writeHistory(home, id, events) {
  const f = historyFile(home, id);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, events.map(([type, data = {}, at = Date.now()]) => JSON.stringify({ type, data, timestamp: new Date(at).toISOString() })).join('\n') + '\n');
  return f;
}

