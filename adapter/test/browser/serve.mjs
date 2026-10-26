// Minimal static file server for the browser test harness.
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.json': 'application/json',
  '.tgz': 'application/gzip',
  '.map': 'application/json',
}

export function serve(root, port = 0) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      let file = path.join(root, decodeURIComponent(url.pathname))
      if (!file.startsWith(root)) {
        res.writeHead(403).end()
        return
      }
      const stat = await fs.stat(file).catch(() => null)
      if (!stat) {
        res.writeHead(404).end('not found: ' + url.pathname)
        return
      }
      if (stat.isDirectory()) file = path.join(file, 'index.html')
      const data = await fs.readFile(file)
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'access-control-allow-origin': '*',
      })
      res.end(data)
    } catch (e) {
      res.writeHead(500).end(String(e))
    }
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve({ server, port: server.address().port }),
    )
  })
}
