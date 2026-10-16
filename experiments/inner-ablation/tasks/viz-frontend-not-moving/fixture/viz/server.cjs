// 六足训练直播服务：训练循环每 100ms 推一帧机体状态（SSE /events）。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8790);
const clients = new Set();

let gen = 0;
let step = 0;
let x = 0;
const bestReward = 0.163;

function frame() {
  step += 1;
  if (step % 25 === 0) gen += 1;
  x += 0.011 + 0.004 * Math.sin(step / 7);
  const yaw = 0.05 * Math.sin(step / 11);
  return {
    type: 'state',
    gen,
    step,
    body: {
      pos: [Number(x.toFixed(5)), 0.2 + 0.01 * Math.sin(step / 3), 0],
      quat: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
    },
    joints: Array.from({ length: 18 }, (_, i) => Number((0.3 * Math.sin(step / 5 + i)).toFixed(4))),
    reward: Number((0.15 + 0.01 * Math.sin(step / 9)).toFixed(5)),
  };
}

setInterval(() => {
  const msg = `data: ${JSON.stringify(frame())}\n\n`;
  for (const res of clients) res.write(msg);
}, 100);

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

http
  .createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ running: true, gen, step, lastReward: 0.16, bestReward, clients: clients.size }));
      return;
    }
    const hit = STATIC[url];
    if (hit) {
      res.writeHead(200, { 'Content-Type': hit[1] });
      res.end(fs.readFileSync(path.join(__dirname, hit[0])));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`viz server on http://127.0.0.1:${PORT}/`);
  });
