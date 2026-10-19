/* ============================================================
   Cloudflare Worker + Durable Object 版联机服务器
   ------------------------------------------------------------
   为什么换掉 P2P：
     1. 公共信令（0.peerjs.com）没有 SLA，按 IP 限流，会抽风
     2. 只有 STUN 没有 TURN，对称 NAT 直接连不上
     3. 房主的浏览器在当服务器，切后台/锁屏整局就冻住

   这个版本把房间逻辑放回服务端，协议和 server.js 完全一致，
   所以前端 game.js / net.js 不用改，只要把地址指过来。

   为什么只用一个 Durable Object 装所有房间：
     代码最简单（房间表就是个 Map），而且 2 人对战的量级离
     单实例 1K req/s 的软上限还差好几个数量级。
     真要扩展，再按房间号 hash 到多个 DO 即可。

   部署：
     npm i -g wrangler
     wrangler login
     wrangler deploy
   ============================================================ */

const DURATION = 90;        // 单局秒数
const COUNTDOWN = 3;        // 开局倒数
const CODE_CHARS = 'ACDEFGHJKLMNPQRSTUVWXYZ23456789';   // 去掉易混的 O/0/I/1/B/8

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // 客户端靠这个判断"这里有没有真服务器"
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, ws: true, duration: DURATION }), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    if (url.pathname === '/ws') {
      const id = env.ROOMS.idFromName('global');
      return env.ROOMS.get(id).fetch(req);
    }

    return new Response('paint3d websocket server\n前端请用 GitHub Pages 那个地址。', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};

/* ---------------- 房间中枢 ---------------- */

export class RoomHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = new Map();     // code -> room
  }

  async fetch(req) {
    if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // 用非 hibernation 的 accept()：房间状态就在内存里，
    // 只要还有连接，DO 就不会被回收，setInterval 也照常跑。
    server.accept();

    const conn = { ws: server, room: null, side: 0, closed: false };

    server.addEventListener('message', ev => this.onMessage(conn, ev.data));
    server.addEventListener('close', () => this.leaveRoom(conn));
    server.addEventListener('error', () => this.leaveRoom(conn));

    return new Response(null, { status: 101, webSocket: client });
  }

  /* ---- 基础 ---- */

  send(conn, obj) {
    if (!conn || conn.closed) return;
    try { conn.ws.send(JSON.stringify(obj)); } catch { /* 对端已经没了 */ }
  }

  broadcast(room, obj, except) {
    for (const c of room.clients) {
      if (c !== except) this.send(c, obj);
    }
  }

  makeCode() {
    let code;
    do {
      code = '';
      for (let i = 0; i < 4; i++) {
        code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      }
    } while (this.rooms.has(code));
    return code;
  }

  /* ---- 对局 ---- */

  // 单局秒数，默认 90。wrangler.toml 里配 [vars] DURATION = "8" 可打快局
  duration() {
    const v = Number(this.env && this.env.DURATION);
    return Number.isFinite(v) && v >= 5 && v <= 90 ? Math.round(v) : DURATION;
  }

  startMatch(room) {
    clearInterval(room.timer);
    const dur = this.duration();
    room.left = dur;
    room.playing = true;

    this.broadcast(room, { t: 'start', in: COUNTDOWN, dur });

    // 服务器权威计时，不依赖任何一端的本地时钟
    room.timer = setInterval(() => {
      room.left -= 1;
      if (room.left <= 0) {
        clearInterval(room.timer);
        room.timer = null;
        room.playing = false;
        this.broadcast(room, { t: 'tick', left: 0 });
        this.broadcast(room, { t: 'end' });
        return;
      }
      this.broadcast(room, { t: 'tick', left: room.left });
    }, 1000);
  }

  leaveRoom(conn) {
    if (conn.closed) return;
    conn.closed = true;

    const room = conn.room;
    if (!room) return;
    conn.room = null;

    const i = room.clients.indexOf(conn);
    if (i >= 0) room.clients.splice(i, 1);

    if (room.clients.length === 0) {
      clearInterval(room.timer);
      this.rooms.delete(room.code);
      return;
    }

    // 还有人，通知他对手走了，房间退回等待状态
    clearInterval(room.timer);
    room.timer = null;
    room.playing = false;
    room.left = this.duration();
    this.broadcast(room, { t: 'peer', state: 'left' });
  }

  onMessage(conn, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    this.handle(conn, msg);
  }

  handle(conn, msg) {
    switch (msg.t) {
      case 'create': {
        if (conn.room) return;
        const code = this.makeCode();
        const room = { code, clients: [conn], timer: null, left: this.duration(), playing: false };
        this.rooms.set(code, room);
        conn.room = room;
        conn.side = 1;
        this.send(conn, { t: 'room', code, side: 1 });
        break;
      }

      case 'join': {
        if (conn.room) return;
        const code = String(msg.code || '').toUpperCase().trim();
        const room = this.rooms.get(code);
        if (!room) { this.send(conn, { t: 'err', msg: '房间不存在' }); return; }
        if (room.clients.length >= 2) { this.send(conn, { t: 'err', msg: '房间已满' }); return; }

        room.clients.push(conn);
        conn.room = room;
        conn.side = 2;
        this.send(conn, { t: 'room', code, side: 2 });
        this.broadcast(room, { t: 'peer', state: 'joined' });
        this.startMatch(room);
        break;
      }

      case 'again': {
        const room = conn.room;
        if (!room || room.clients.length < 2 || room.playing) return;
        this.startMatch(room);
        break;
      }

      case 'p': {
        const room = conn.room;
        if (!room || !room.playing) return;
        this.broadcast(room, { t: 'p', x: msg.x, z: msg.z, f: msg.f }, conn);
        break;
      }

      case 'ink': {
        const room = conn.room;
        if (!room || !room.playing) return;
        if (!Array.isArray(msg.s) || msg.s.length === 0) return;
        this.broadcast(room, { t: 'ink', s: msg.s }, conn);
        break;
      }

      case 'leave':
        this.leaveRoom(conn);
        try { conn.ws.close(); } catch {}
        break;
    }
  }
}
