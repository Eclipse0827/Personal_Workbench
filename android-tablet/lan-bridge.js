'use strict';

/**
 * LAN bridge for the tablet shell.
 *
 * The existing server keeps listening on 127.0.0.1:5180, so the tablet cannot
 * reach it directly. This process listens on all interfaces (5181 by default)
 * and forwards requests to the local server without touching any data.
 */

const http = require('http');
const os = require('os');

const TARGET_HOST = process.env.TARGET_HOST || '127.0.0.1';
const TARGET_PORT = Number(process.env.TARGET_PORT || 5180);
const LISTEN_PORT = Number(process.env.PORT || 5181);
const LISTEN_HOST = process.env.HOST || '0.0.0.0';

const server = http.createServer((req, res) => {
  const proxy = http.request({
    hostname: TARGET_HOST,
    port: TARGET_PORT,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` },
  }, (upstream) => {
    res.writeHead(upstream.statusCode || 502, upstream.headers);
    upstream.pipe(res);
  });

  proxy.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end(`连不上本机服务 ${TARGET_HOST}:${TARGET_PORT}\n${err.message}\n`);
  });

  req.pipe(proxy);
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.on('clientError', (err, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`平板桥接已启动：0.0.0.0:${LISTEN_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`);
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const addr of list || []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        console.log(`  http://${addr.address}:${LISTEN_PORT}  (${name})`);
      }
    }
  }
  console.log('保持这个窗口开着；按 Ctrl+C 停止。');
});