import { randomInt } from 'node:crypto';
import { createServer } from 'node:net';

function canBind(host, port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

// Parallel CI jobs share one host, so tests must not bind literal ports.
// Probe random ports in BRIDGE_PORT_MIN..MAX (port 0 on Linux mostly lands below that range).
// span: also require port+1..port+span-1 free, for products that step to the next port.
// shortcut: the port is free only at this moment, another process can still take it before use.
export async function freePort(host = '127.0.0.1', { avoid = [], span = 1, min = 49_152, max = 65_535 } = {}) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const port = randomInt(min, max - span + 2);
    if (avoid.includes(port)) continue;
    let free = true;
    for (let offset = 0; free && offset < span; offset += 1) free = await canBind(host, port + offset);
    if (free) return port;
  }
  throw new Error(`no free port in ${min}..${max} on ${host}`);
}
