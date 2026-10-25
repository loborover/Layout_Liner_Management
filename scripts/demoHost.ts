/**
 * @file demoHost.ts
 *
 * Example host server for the monitoring viewer (docs/VIEWER.md): serves random values for the given keys both as
 * REST (GET /values) and as WebSocket push (ws://…/live), so the viewer can be tried without real equipment.
 * A real host server only needs to produce the same JSON.
 *
 *   npm run demo:host -- --port 7830 --keys line1.temp,line1.state,lift-1
 *   viewer.html?drawing=…&source=ws://127.0.0.1:7830/live      (push)
 *   viewer.html?drawing=…&source=http://127.0.0.1:7830/values  (polling)
 */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const port = Number(arg('--port', '7830'));
const keys = arg('--keys', 'line1.temp,line1.pressure,lift-1').split(',').filter(Boolean);
const level = new Map(keys.map((k) => [k, 50]));

/** One snapshot in the { values: { key: { value, status, unit } } } form; status is left to viewer thresholds. */
function snapshot() {
  const values: Record<string, { value: number; unit: string }> = {};
  for (const k of keys) {
    const v = Math.min(100, Math.max(0, level.get(k)! + (Math.random() - 0.5) * 12));
    level.set(k, v);
    values[k] = { value: Math.round(v * 10) / 10, unit: k.includes('temp') ? '°C' : '' };
  }
  return { values };
}

const http = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url?.startsWith('/values')) {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(snapshot()));
  } else {
    res.statusCode = 404;
    res.end();
  }
});
const wss = new WebSocketServer({ server: http, path: '/live' });
setInterval(() => {
  const msg = JSON.stringify(snapshot());
  for (const c of wss.clients) c.send(msg);
}, 1000);
http.listen(port, () => console.log(`demo host: http://127.0.0.1:${port}/values, ws://127.0.0.1:${port}/live, keys ${keys.join(', ')}`));
