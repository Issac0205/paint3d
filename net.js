/* ============================================================
   net.js —— 客户端网络层（两种传输，同一套接口）
   ------------------------------------------------------------
   对 game.js 来说只有四个方法：on / connect / send / close，
   消息格式也完全一样（t 字段区分类型）。底下可以有两种实现：

     1. ws   —— 连本机的 server.js（局域网 / 本地双击启动时用）
     2. p2p  —— WebRTC 直连，房主的浏览器自己扮演服务器

   为什么要有 p2p：GitHub Pages 只能放静态文件，跑不了 Node 进程。
   所以部署到 Pages 时自动切到 p2p，房主那一端负责开局、计时、
   转发，客人直连过去。协议和 ws 版逐字相同，所以 game.js 不用改。

   选哪个由 connect() 时探测 ./health 决定：自己的服务器会回
   {ws:true}，静态托管（GitHub Pages / python -m http.server）会 404。
   ============================================================ */

const PREFIX = 'paint3d-';
const CODE_CHARS = 'ACDEFGHJKLMNPQRSTUVWXYZ23456789';   // 去掉容易看错的 O/0/I/1/B/8
const COUNTDOWN = 3;

// 单局秒数。默认 90，加 ?dur=8 可以打快局（调试 / 演示用）
const DURATION = (() => {
  const v = Number(new URLSearchParams(location.search).get('dur'));
  return Number.isFinite(v) && v >= 5 && v <= 90 ? Math.round(v) : 90;
})();

// 只用公共 STUN，没有 TURN。对称 NAT 下会连不上，这是免费方案的代价。
const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ],
};

function makeCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

/* ---------------- 探测：这台机器上有没有自己的服务器 ---------------- */

async function pickTransport() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch('./health', { cache: 'no-store', signal: ctl.signal });
    clearTimeout(t);
    if (r.ok) {
      const j = await r.json();
      if (j && j.ws) return 'ws';
    }
  } catch { /* 静态托管会 404 或者超时，走 p2p */ }
  return 'p2p';
}

/* ---------------- WebSocket 传输 ---------------- */

function wsTransport(emit) {
  let ws = null;

  function connect() {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      let settled = false;

      try {
        ws = new WebSocket(`${proto}//${location.host}/ws`);
      } catch {
        reject(new Error('浏览器不支持 WebSocket'));
        return;
      }

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch {}
        reject(new Error('连接超时'));
      }, 6000);

      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('连不上服务器'));
      };

      ws.onclose = () => emit('close');

      ws.onmessage = ev => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg && typeof msg.t === 'string') emit(msg.t, msg);
      };
    });
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function close() {
    if (ws) { try { ws.close(); } catch {} ws = null; }
  }

  return { connect, send, close, kind: 'ws' };
}

/* ---------------- P2P 传输（房主端顺便当服务器） ---------------- */

function loadPeerJS() {
  if (window.Peer) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('./lib/peerjs.min.js', import.meta.url).href;
    s.onload = () => (window.Peer ? resolve() : reject(new Error('PeerJS 加载失败')));
    s.onerror = () => reject(new Error('PeerJS 加载失败'));
    document.head.appendChild(s);
  });
}

function waitOpen(p, ms = 12000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('信令服务超时')), ms);
    const ok = () => { clearTimeout(to); resolve(); };
    const bad = e => { clearTimeout(to); reject(e); };
    p.once('open', ok);
    p.once('error', bad);
  });
}

function p2pTransport(emit) {
  let peer = null;
  let conn = null;
  let side = 0;
  let code = '';
  let timer = null;
  let left = 0;
  let playing = false;
  let dead = false;

  /* ---- 心跳 ----
     WebRTC 在对端进程被直接杀掉时不会主动报 close（实测 45 秒都没有），
     所以两边互发 ping 自己数。18 秒没有任何消息就认为对方走了。
     后台标签页的 setInterval 会被节流到约 1 次/秒（5 分钟后到 1 次/分），
     2 秒一次的心跳在这个阈值内仍然够用。 */
  const HB_MS = 2000;
  const HB_TIMEOUT = 18000;
  let lastSeen = 0;
  let hbSend = null;
  let hbWatch = null;

  function stopHeartbeat() {
    clearInterval(hbSend); hbSend = null;
    clearInterval(hbWatch); hbWatch = null;
  }

  function dropPeer() {
    if (dead) return;
    const c = conn;
    conn = null;
    stopMatch();
    stopHeartbeat();
    if (c) { try { c.close(); } catch {} }
    emit('peer', { state: 'left' });
  }

  function startHeartbeat() {
    stopHeartbeat();
    lastSeen = Date.now();

    hbSend = setInterval(() => {
      if (conn) { try { conn.send({ t: 'ping' }); } catch {} }
    }, HB_MS);

    hbWatch = setInterval(() => {
      if (dead || !conn) return;
      if (Date.now() - lastSeen > HB_TIMEOUT) dropPeer();
    }, 1000);
  }

  // 自己从后台切回来时，先当作"刚收到消息"，别一回来就误判对方掉线
  document.addEventListener('visibilitychange', () => {
    if (!dead && !document.hidden) lastSeen = Date.now();
  });

  /* ---- 房主端：把 server.js 那套逻辑搬进浏览器 ---- */

  function deliver(obj) {
    emit(obj.t, obj);
    if (conn && conn.open) {
      try { conn.send(obj); } catch {}
    }
  }

  function startMatch() {
    clearInterval(timer);
    left = DURATION;
    playing = true;
    deliver({ t: 'start', in: COUNTDOWN, dur: DURATION });
    timer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(timer);
        timer = null;
        playing = false;
        deliver({ t: 'tick', left: 0 });
        deliver({ t: 'end' });
        return;
      }
      deliver({ t: 'tick', left });
    }, 1000);
  }

  function stopMatch() {
    clearInterval(timer);
    timer = null;
    playing = false;
    left = DURATION;
  }

  function onGuestData(msg) {
    if (!msg || typeof msg.t !== 'string') return;
    lastSeen = Date.now();
    if (msg.t === 'ping') return;
    if (msg.t === 'p' || msg.t === 'ink') {
      if (playing) emit(msg.t, msg);      // 房主自己也要看到对手的涂色
    } else if (msg.t === 'again') {
      if (conn && conn.open && !playing) startMatch();
    } else if (msg.t === 'leave') {
      close();
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // 客人也走显式 id。PeerJS 在"随机 id"模式下会先请求
  // 0.peerjs.com/peerjs/id 拿一个编号，多一次 HTTP 往返；那一步一旦慢，
  // 就会撞上连接超时。房主因为带了 id 不受影响，症状就是
  // "房主建得出房间、客人死活进不去"。
  function guestId() {
    return 'g' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  function explain(e) {
    if (!e) return '未知错误';
    if (e.type === 'browser-incompatible') return '这个浏览器不支持 WebRTC';
    if (e.type === 'network' || e.type === 'server-error') return '信令服务器连不上';
    if (e.type === 'socket-error' || e.type === 'socket-closed') return '信令连接被断开';
    if (!e.type) return '信令服务器没有响应';
    return e.type;
  }

  async function hostCreate() {
    try {
      await loadPeerJS();
    } catch {
      emit('err', { msg: 'PeerJS 加载失败，检查网络后刷新页面' });
      return;
    }

    let lastErr = null;

    // 4 位码有撞号的可能（公共信令是全服共享的），撞了就换一个；
    // 网络类的错误也重试几次，公共信令偶尔会抽风。
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt === 0) {
        emit('status', { text: '正在连接信令服务器…' });
      } else {
        emit('status', { text: `信令服务器没响应，正在重试（${attempt + 1}/6）…` });
        await sleep(1200 * attempt);
      }

      const c = makeCode();
      const p = new window.Peer(PREFIX + c, { debug: 0, config: ICE });

      try {
        await waitOpen(p, 15000);
      } catch (e) {
        lastErr = e;
        try { p.destroy(); } catch {}
        continue;                       // 撞号或网络抖动，换一个再来
      }

      emit('status', { text: '' });
      peer = p;
      code = c;
      side = 1;

      p.on('connection', c2 => {
        if (dead) return;
        if (conn && conn.open) { try { c2.close(); } catch {} return; }  // 房间满了
        conn = c2;
        c2.on('open', () => {
          startHeartbeat();
          emit('peer', { state: 'joined' });
          startMatch();
        });
        c2.on('data', onGuestData);
        c2.on('close', () => {
          conn = null;
          stopMatch();
          stopHeartbeat();
          if (!dead) emit('peer', { state: 'left' });
        });
        c2.on('error', () => {});
      });

      p.on('error', e => {
        if (dead) return;
        if (e && (e.type === 'network' || e.type === 'server-error')) {
          emit('err', { msg: '信令服务连不上，检查一下网络' });
        }
      });

      emit('room', { code: c, side: 1 });
      return;
    }

    emit('status', { text: '' });
    emit('err', { msg: '创建房间失败：' + explain(lastErr) + '，稍后重试即可' });
  }

  /* ---- 客人端 ---- */

  async function guestJoin(want) {
    try {
      await loadPeerJS();
    } catch {
      emit('err', { msg: 'PeerJS 加载失败，检查网络后刷新页面' });
      return;
    }

    let lastErr = null;
    let p = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt === 0) {
        emit('status', { text: '正在连接信令服务器…' });
      } else {
        emit('status', { text: `信令服务器没响应，正在重试（${attempt + 1}/3）…` });
        await sleep(1200 * attempt);
      }

      p = new window.Peer(guestId(), { debug: 0, config: ICE });
      try {
        await waitOpen(p, 15000);
        break;
      } catch (e) {
        lastErr = e;
        try { p.destroy(); } catch {}
        p = null;
      }
    }

    if (!p) {
      emit('status', { text: '' });
      emit('err', { msg: '连不上信令服务器：' + explain(lastErr) + '，稍后重试（也可以先玩单机）' });
      return;
    }

    emit('status', { text: '正在连接房主…' });
    peer = p;
    side = 2;
    code = want;

    peer.on('error', e => {
      if (dead) return;
      if (e && e.type === 'peer-unavailable') {
        emit('err', { msg: '房间不存在，或者房主已经离开了' });
      } else if (e && (e.type === 'network' || e.type === 'server-error')) {
        emit('err', { msg: '信令服务连不上，检查一下网络' });
      }
    });

    conn = peer.connect(PREFIX + want, { reliable: true });

    const to = setTimeout(() => {
      if (!dead && !(conn && conn.open)) {
        emit('status', { text: '' });
        emit('err', { msg: '连接超时，可能被网络限制了' });
      }
    }, 20000);

    conn.on('open', () => {
      clearTimeout(to);
      emit('status', { text: '' });
      startHeartbeat();
      emit('room', { code: want, side: 2 });
    });
    conn.on('data', msg => {
      if (!msg || typeof msg.t !== 'string') return;
      lastSeen = Date.now();
      if (msg.t === 'ping') return;
      emit(msg.t, msg);
    });
    conn.on('close', () => {
      clearTimeout(to);
      conn = null;
      stopHeartbeat();
      if (!dead) emit('peer', { state: 'left' });
    });
  }

  /* ---- 对外接口 ---- */

  function connect() {
    // P2P 没有"连服务器"这一步，真正的动作在 send({t:'create'|'join'}) 里
    return Promise.resolve();
  }

  function send(obj) {
    if (!obj) return;

    if (obj.t === 'create') {
      hostCreate().catch(e => emit('err', { msg: '创建房间出错：' + (e && e.message || e) }));
      return;
    }
    if (obj.t === 'join') {
      guestJoin(String(obj.code || '').toUpperCase())
        .catch(e => emit('err', { msg: '进入房间出错：' + (e && e.message || e) }));
      return;
    }

    // 房主按"再来一局"：不需要发给谁，自己开局，start 会自动广播
    if (side === 1 && obj.t === 'again') {
      if (!conn) { dropPeer(); return; }
      if (!playing) startMatch();
      return;
    }

    if (side === 2 && obj.t === 'again' && !conn) { dropPeer(); return; }

    if (conn && conn.open) {
      try { conn.send(obj); } catch {}
    }
  }

  function close() {
    dead = true;
    stopMatch();
    stopHeartbeat();
    if (conn) { try { conn.close(); } catch {} conn = null; }
    if (peer) { try { peer.destroy(); } catch {} peer = null; }
  }

  return { connect, send, close, kind: 'p2p' };
}

/* ---------------- 统一外壳 ---------------- */

export function createNet() {
  const listeners = new Map();
  let impl = null;
  let kind = '';

  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  }

  function emit(type, payload) {
    const list = listeners.get(type);
    if (!list) return;
    for (const fn of list) {
      try { fn(payload); } catch (e) { console.error(e); }
    }
  }

  async function connect() {
    if (impl) return impl.connect();
    kind = await pickTransport();
    impl = kind === 'ws' ? wsTransport(emit) : p2pTransport(emit);
    return impl.connect();
  }

  function send(obj) { if (impl) impl.send(obj); }
  function close() { if (impl) impl.close(); impl = null; }

  return {
    on, connect, send, close,
    get kind() { return kind; },
  };
}
