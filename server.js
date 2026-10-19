/* ============================================================
   server.js —— 静态文件 + WebSocket 房间服务（零依赖）
   ------------------------------------------------------------
   为什么不用 ws 包：这个项目一直保持"双击就能跑、不装依赖"。
   WebSocket 握手和帧解析都是 RFC 6455 里写死的东西，自己实现
   一百多行就够，而且只需要文本帧、单帧消息（我们每条消息都远小于
   一个 MTU，不会被分片）。

   用法：
     node server.js            默认 8848
     PORT=9000 node server.js  换端口
   ============================================================ */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8848;
const ROOT = __dirname;
// 单局秒数。默认 90，可用 DURATION=15 覆盖（调试或想打快局时用）
const DURATION = Number(process.env.DURATION) || 90;
const COUNTDOWN = 3;        // 开局倒数
const MAX_PAYLOAD = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ---------------- 静态文件 ---------------- */

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  // 客户端靠这个探测"这台机器上有没有自己的服务器"。
  // 部署到 GitHub Pages 时这里是 404，客户端会自动退回 P2P 直连。
  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, ws: true, duration: DURATION }));
    return;
  }

  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(ROOT, rel);

  // 防目录穿越
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

/* ---------------- WebSocket 基础 ---------------- */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(payload, opcode = 0x1) {
  const len = payload.length;
  let head;

  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode;   // FIN + opcode
  return Buffer.concat([head, payload]);
}

/** 从缓冲区里切出完整的一帧；数据不够就返回 null 等下一批 */
function decodeFrame(buf) {
  if (buf.length < 2) return null;

  const b0 = buf[0];
  const b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;

  let len = b1 & 0x7f;
  let off = 2;

  if (len === 126) {
    if (buf.length < off + 2) return null;
    len = buf.readUInt16BE(off);
    off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return null;
    const big = buf.readBigUInt64BE(off);
    if (big > BigInt(MAX_PAYLOAD)) return { opcode: 0x8, payload: Buffer.alloc(0), size: buf.length };
    len = Number(big);
    off += 8;
  }

  if (len > MAX_PAYLOAD) return { opcode: 0x8, payload: Buffer.alloc(0), size: buf.length };

  let mask = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.subarray(off, off + 4);
    off += 4;
  }

  if (buf.length < off + len) return null;

  const payload = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) {
    payload[i] = mask ? buf[off + i] ^ mask[i & 3] : buf[off + i];
  }

  return { opcode, payload, size: off + len };
}

class Conn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.room = null;
    this.side = 0;

    socket.setNoDelay(true);
    socket.on('data', d => this.onData(d));
    socket.on('close', () => this.teardown());
    socket.on('error', () => this.teardown());
    socket.on('end', () => this.teardown());
  }

  onData(chunk) {
    if (this.closed) return;
    this.buf = Buffer.concat([this.buf, chunk]);

    // 一条 TCP 包里可能有多帧，也可能只有半帧，循环切到切不动为止
    for (;;) {
      const f = decodeFrame(this.buf);
      if (!f) break;

      this.buf = this.buf.subarray(f.size);

      if (f.opcode === 0x8) { this.close(); return; }
      if (f.opcode === 0x9) { this.write(encodeFrame(f.payload, 0xa)); continue; }
      if (f.opcode === 0xa) continue;
      if (f.opcode === 0x1) this.onText(f.payload.toString('utf8'));
    }
  }

  write(buf) {
    if (this.closed) return;
    try { this.socket.write(buf); } catch { this.teardown(); }
  }

  send(obj) {
    this.write(encodeFrame(Buffer.from(JSON.stringify(obj), 'utf8'), 0x1));
  }

  onText(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    handle(this, msg);
  }

  close() {
    if (this.closed) return;
    this.write(encodeFrame(Buffer.alloc(0), 0x8));
    this.socket.end();
    this.teardown();
  }

  teardown() {
    if (this.closed) return;
    this.closed = true;
    leaveRoom(this);
    try { this.socket.destroy(); } catch {}
  }
}

/* ---------------- 房间 ---------------- */

const rooms = new Map();          // code -> room
const CODE_CHARS = 'ACDEFGHJKLMNPQRSTUVWXYZ23456789';   // 去掉容易看错的 O/0/I/1/B/8

function makeCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

function broadcast(room, obj, except) {
  for (const c of room.clients) {
    if (c !== except && !c.closed) c.send(obj);
  }
}

function startMatch(room) {
  clearInterval(room.timer);
  room.left = DURATION;
  room.playing = true;

  broadcast(room, { t: 'start', in: COUNTDOWN, dur: DURATION });

  // 用固定间隔自己数，不依赖客户端时钟
  room.timer = setInterval(() => {
    room.left -= 1;
    if (room.left <= 0) {
      clearInterval(room.timer);
      room.timer = null;
      room.playing = false;
      broadcast(room, { t: 'tick', left: 0 });
      broadcast(room, { t: 'end' });
      return;
    }
    broadcast(room, { t: 'tick', left: room.left });
  }, 1000);
}

function leaveRoom(conn) {
  const room = conn.room;
  if (!room) return;
  conn.room = null;

  const i = room.clients.indexOf(conn);
  if (i >= 0) room.clients.splice(i, 1);

  if (room.clients.length === 0) {
    clearInterval(room.timer);
    rooms.delete(room.code);
    return;
  }

  // 还有人，通知他对手走了，房间退回等待状态
  clearInterval(room.timer);
  room.timer = null;
  room.playing = false;
  room.left = DURATION;
  broadcast(room, { t: 'peer', state: 'left' });
}

function handle(conn, msg) {
  switch (msg.t) {
    case 'create': {
      if (conn.room) return;
      const code = makeCode();
      const room = { code, clients: [conn], timer: null, left: DURATION, playing: false };
      rooms.set(code, room);
      conn.room = room;
      conn.side = 1;
      conn.send({ t: 'room', code, side: 1 });
      break;
    }

    case 'join': {
      if (conn.room) return;
      const code = String(msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) { conn.send({ t: 'err', msg: '房间不存在' }); return; }
      if (room.clients.length >= 2) { conn.send({ t: 'err', msg: '房间已满' }); return; }

      room.clients.push(conn);
      conn.room = room;
      conn.side = 2;
      conn.send({ t: 'room', code, side: 2 });
      broadcast(room, { t: 'peer', state: 'joined' });
      startMatch(room);
      break;
    }

    case 'again': {
      const room = conn.room;
      if (!room || room.clients.length < 2 || room.playing) return;
      startMatch(room);
      break;
    }

    case 'p': {
      const room = conn.room;
      if (!room || !room.playing) return;
      broadcast(room, { t: 'p', x: msg.x, z: msg.z, f: msg.f }, conn);
      break;
    }

    case 'ink': {
      const room = conn.room;
      if (!room || !room.playing) return;
      if (!Array.isArray(msg.s) || msg.s.length === 0) return;
      broadcast(room, { t: 'ink', s: msg.s }, conn);
      break;
    }

    case 'leave':
      conn.close();
      break;
  }
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );

  new Conn(socket);
});

/* ---------------- 启动 ---------------- */

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  涂地大作战 · 服务器已启动');
  console.log('  ─────────────────────────────────────');
  console.log(`  本机打开：   http://127.0.0.1:${PORT}/`);
  for (const ip of lanAddresses()) {
    console.log(`  同一 WiFi：  http://${ip}:${PORT}/   （手机 / 另一台电脑用这个）`);
  }
  console.log('  ─────────────────────────────────────');
  console.log('  按 Ctrl+C 停止');
  console.log('');
});
