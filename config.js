/* ============================================================
   config.js —— 部署配置
   ------------------------------------------------------------
   留空时：页面加载后会探测 ./health。
     · 有自己的服务器（node server.js）→ 走 WebSocket
     · 静态托管（GitHub Pages 等）→ 退回浏览器 P2P 直连

   如果你把服务器部署在别处（Cloudflare Worker / 云服务器 / 内网机器），
   把地址填在下面，页面会直接连它，不再走 P2P：

     window.PAINT3D_WS = 'wss://paint3d.example.workers.dev/ws';
     window.PAINT3D_WS = 'ws://192.168.1.10:8848/ws';

   也可以临时用地址栏参数覆盖：index.html?ws=wss://xxx/ws
   ============================================================ */

window.PAINT3D_WS = '';
