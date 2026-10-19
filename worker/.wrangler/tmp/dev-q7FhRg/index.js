var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var DURATION = 90;
var COUNTDOWN = 3;
var CODE_CHARS = "ACDEFGHJKLMNPQRSTUVWXYZ23456789";
var src_default = {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, ws: true, duration: DURATION }), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
    if (url.pathname === "/ws") {
      const id = env.ROOMS.idFromName("global");
      return env.ROOMS.get(id).fetch(req);
    }
    return new Response("paint3d websocket server\n\u524D\u7AEF\u8BF7\u7528 GitHub Pages \u90A3\u4E2A\u5730\u5740\u3002", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
};
var RoomHub = class {
  static {
    __name(this, "RoomHub");
  }
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = /* @__PURE__ */ new Map();
  }
  async fetch(req) {
    if ((req.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const conn = { ws: server, room: null, side: 0, closed: false };
    server.addEventListener("message", (ev) => this.onMessage(conn, ev.data));
    server.addEventListener("close", () => this.leaveRoom(conn));
    server.addEventListener("error", () => this.leaveRoom(conn));
    return new Response(null, { status: 101, webSocket: client });
  }
  /* ---- 基础 ---- */
  send(conn, obj) {
    if (!conn || conn.closed) return;
    try {
      conn.ws.send(JSON.stringify(obj));
    } catch {
    }
  }
  broadcast(room, obj, except) {
    for (const c of room.clients) {
      if (c !== except) this.send(c, obj);
    }
  }
  makeCode() {
    let code;
    do {
      code = "";
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
    this.broadcast(room, { t: "start", in: COUNTDOWN, dur });
    room.timer = setInterval(() => {
      room.left -= 1;
      if (room.left <= 0) {
        clearInterval(room.timer);
        room.timer = null;
        room.playing = false;
        this.broadcast(room, { t: "tick", left: 0 });
        this.broadcast(room, { t: "end" });
        return;
      }
      this.broadcast(room, { t: "tick", left: room.left });
    }, 1e3);
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
    clearInterval(room.timer);
    room.timer = null;
    room.playing = false;
    room.left = this.duration();
    this.broadcast(room, { t: "peer", state: "left" });
  }
  onMessage(conn, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== "string") return;
    this.handle(conn, msg);
  }
  handle(conn, msg) {
    switch (msg.t) {
      case "create": {
        if (conn.room) return;
        const code = this.makeCode();
        const room = { code, clients: [conn], timer: null, left: this.duration(), playing: false };
        this.rooms.set(code, room);
        conn.room = room;
        conn.side = 1;
        this.send(conn, { t: "room", code, side: 1 });
        break;
      }
      case "join": {
        if (conn.room) return;
        const code = String(msg.code || "").toUpperCase().trim();
        const room = this.rooms.get(code);
        if (!room) {
          this.send(conn, { t: "err", msg: "\u623F\u95F4\u4E0D\u5B58\u5728" });
          return;
        }
        if (room.clients.length >= 2) {
          this.send(conn, { t: "err", msg: "\u623F\u95F4\u5DF2\u6EE1" });
          return;
        }
        room.clients.push(conn);
        conn.room = room;
        conn.side = 2;
        this.send(conn, { t: "room", code, side: 2 });
        this.broadcast(room, { t: "peer", state: "joined" });
        this.startMatch(room);
        break;
      }
      case "again": {
        const room = conn.room;
        if (!room || room.clients.length < 2 || room.playing) return;
        this.startMatch(room);
        break;
      }
      case "p": {
        const room = conn.room;
        if (!room || !room.playing) return;
        this.broadcast(room, { t: "p", x: msg.x, z: msg.z, f: msg.f }, conn);
        break;
      }
      case "ink": {
        const room = conn.room;
        if (!room || !room.playing) return;
        if (!Array.isArray(msg.s) || msg.s.length === 0) return;
        this.broadcast(room, { t: "ink", s: msg.s }, conn);
        break;
      }
      case "leave":
        this.leaveRoom(conn);
        try {
          conn.ws.close();
        } catch {
        }
        break;
    }
  }
};

// ../../../../AppData/Local/Temp/cfwtest/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../AppData/Local/Temp/cfwtest/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-nNGRgB/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../../../AppData/Local/Temp/cfwtest/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-nNGRgB/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  RoomHub,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
