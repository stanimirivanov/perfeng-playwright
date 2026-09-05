import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(
  new URL('./fixtures/search.html', import.meta.url),
);

const server = createServer((request, response) => {
  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET' });
    response.end();
    return;
  }
  if (request.url === '/health') {
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.url !== '/') {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8',
  });
  createReadStream(fixture).pipe(response);
});

server.listen(4173, '127.0.0.1');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
