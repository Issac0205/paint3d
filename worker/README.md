# Cloudflare Worker 版联机服务器

前端还是放在 GitHub Pages，这个 Worker 只负责 WebSocket 房间服务。
协议和 `../server.js` 完全一致，所以 `game.js` 一行都不用改。

## 为什么需要它

浏览器 P2P 那套有三个结构性弱点：

1. 依赖公共信令 `0.peerjs.com`——第三方免费服务，没有 SLA，按 IP 限流
2. 只配了 STUN 没有 TURN，对称 NAT（部分 4G/5G、公司网络、校园网）直连不上
3. 房主的浏览器在当服务器，切后台、锁屏、WiFi 抖动都会让整局冻住

换成服务端转发之后这三个问题都不存在了：房间和计时都在服务端，断线靠 TCP 立刻就能发现。

## 部署

```bash
cd worker
npx wrangler login      # 浏览器里授权一次
npx wrangler deploy
```

成功后终端会打印一个地址，形如：

```
https://paint3d-ws.你的子域.workers.dev
```

把 WebSocket 地址填进上一层的 `config.js`：

```js
window.PAINT3D_WS = 'wss://paint3d-ws.你的子域.workers.dev/ws';
```

然后提交并推到 GitHub Pages 即可。

## 免费额度够不够

Durable Objects 从 2024 年起在免费套餐里可用，但**必须用 SQLite 后端**——
`wrangler.toml` 里的 `new_sqlite_classes = ["RoomHub"]` 就是干这个的，别删。

免费额度对 2 人对战来说非常宽裕（每天 10 万次请求 + 1 万 GB·秒的 DO 时长）。
一局 90 秒、两条连接，大约消耗 0.2 GB·秒。

## 本地调试

```bash
cd worker
npx wrangler dev --local --port 8787
```

然后前端用 `?ws=` 指过来，不用改 `config.js`：

```
http://127.0.0.1:8850/?ws=ws://127.0.0.1:8787/ws
```

想打快局可以加 `--var DURATION:8`（5–90 秒之间）。

## 一个房间中枢装所有房间

`RoomHub` 是单个 Durable Object 实例，里面就是一个 `Map<房间号, 房间>`。
这样做代码最简单，而且 2 人对战的量级离单实例约 1K req/s 的软上限还差好几个数量级。

真要扩展，按房间号哈希到多个 DO 就行，协议不用动。

## 中国大陆访问的注意事项

`*.workers.dev` 在国内的连通性不稳定，时好时坏。如果你的玩家都在国内，
更稳的做法是买一台国内轻量云服务器（约 ¥99/年）跑 `../server.js`：

```bash
# 服务器上
node server.js                       # 监听 8848
# 用 Caddy 反代并自动签 HTTPS
```

```caddyfile
game.example.com {
    reverse_proxy 127.0.0.1:8848
}
```

前端 `config.js` 改成 `wss://game.example.com/ws` 即可，代码完全不用动。
注意国内服务器绑定域名需要备案。

## 三种方案对比

| | P2P（现状） | Cloudflare Worker | 国内轻量云 |
| --- | --- | --- | --- |
| 费用 | 免费 | 免费 | 约 ¥99/年 |
| 需要账号 | 否 | Cloudflare | 云厂商 + 备案 |
| 对称 NAT | 连不上 | 正常 | 正常 |
| 房主切后台 | 整局冻结 | 不受影响 | 不受影响 |
| 断线察觉 | 约 19 秒（心跳） | 约 1 秒（TCP） | 约 1 秒（TCP） |
| 国内连通性 | 看运气 | 不稳定 | 最好 |
| 运维 | 无 | 无 | 要管进程和证书 |
