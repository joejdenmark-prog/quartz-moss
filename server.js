const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3001;
const ROOT = __dirname;

const MIME = {
  '.html':  'text/html',
  '.css':   'text/css',
  '.js':    'application/javascript',
  '.json':  'application/json',
  '.wasm':  'application/wasm',
  '.gltf':  'model/gltf+json',
  '.glb':   'model/gltf-binary',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.svg':   'image/svg+xml',
  '.ico':   'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.resolve(ROOT, '.' + urlPath);
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other process or set a different PORT.`);
    process.exit(1);
  } else {
    throw err;
  }
});

server.listen(PORT, () => {
  console.log(`Quartz Moss Wall v2 running at http://localhost:${PORT}`);
});
