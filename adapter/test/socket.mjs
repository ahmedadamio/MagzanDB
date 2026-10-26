// pglite-socket e2e: real pg client over TCP to the Rust-backed adapter.
import { createRequire } from 'module'
const require = createRequire(
  '/Users/ahmed/Desktop/majaz/lab/pglite/packages/pglite-node-postgres/package.json',
)
const { Client } = require('pg')
const { PGlite } = await import('../src/index.js')
const { PGLiteSocketServer } = await import('../src/socket.js')

let pass = 0
const ok = (name, cond) => {
  if (!cond) throw new Error(`FAIL ${name}`)
  console.log(`ok ${name}`)
  pass++
}

const db = await PGlite.create({})
const server = new PGLiteSocketServer({ db, port: 0, maxConnections: 4 })
await server.start()
const port = server.port
console.log('listening on', server.getServerConn())

const client = new Client({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres' })
client.on('error', () => {})
await client.connect()
ok('connected', true)

const r = await client.query('SELECT $1::int a, $2::text b', [7, 'sock'])
ok('param query', r.rows[0].a === 7 && r.rows[0].b === 'sock')

await client.query('CREATE TABLE t (v int)')
await client.query('INSERT INTO t VALUES (1),(2),(3)')
const c = await client.query('SELECT count(*)::int n FROM t')
ok('count', c.rows[0].n === 3)

// second concurrent client (queued through the single connection)
const client2 = new Client({ host: '127.0.0.1', port, user: 'x', database: 'y' })
client2.on('error', () => {})
await client2.connect()
const r2 = await client2.query('SELECT 9 n')
ok('second client', r2.rows[0].n === 9)

// error surfacing
try {
  await client.query('SELECT * FROM missing_zz')
  ok('error surfaced', false)
} catch (e) {
  ok('error surfaced', e.code === '42P01')
}

// transaction over socket incl. multi-query exec
await client.query('BEGIN')
await client.query('INSERT INTO t VALUES (4)')
await client.query('COMMIT')
const after = await client.query('SELECT count(*)::int n FROM t')
ok('socket tx', after.rows[0].n === 4)

await client2.end()

// concurrency: 3 parallel clients (with the main client = maxConnections)
// × 10 interleaved queries — each must get its own value back through the
// serialized queue.
const parallel = await Promise.all(
  Array.from({ length: 3 }, async (_, ci) => {
    const c = new Client({ host: '127.0.0.1', port, user: 'x', database: 'y' })
    c.on('error', () => {})
    await c.connect()
    const vals = []
    for (let i = 0; i < 10; i++) {
      const tag = ci * 1000 + i
      const rr = await c.query('SELECT $1::int AS v', [tag])
      vals.push(rr.rows[0].v)
    }
    await c.end()
    return vals
  }),
)
ok(
  'parallel clients no crosstalk',
  parallel.every((vals, ci) =>
    vals.every((v, i) => v === ci * 1000 + i)),
)

// connection beyond maxConnections is rejected without crashing the server
{
  const srv1 = new PGLiteSocketServer({ db, port: 0, maxConnections: 1 })
  await srv1.start()
  const p1 = srv1.port
  const held = new Client({ host: '127.0.0.1', port: p1, user: 'x', database: 'y' })
  await held.connect()
  const over = new Client({ host: '127.0.0.1', port: p1, user: 'x', database: 'y' })
  let rejected = false
  try {
    await over.connect()
    await over.query('SELECT 1')
  } catch {
    rejected = true
  }
  over.on('error', () => {})
  try { over.end() } catch {}
  ok('connection over limit rejected', rejected)
  await held.end()
  await srv1.stop()
}

// client disconnect mid-queue doesn't wedge the queue
const dc = new Client({ host: '127.0.0.1', port, user: 'x', database: 'y' })
await dc.connect()
const dropped = dc.query('SELECT pg_sleep(0.01)').catch(() => 'dropped')
dc.on('error', () => {}) // client-side reset is expected mid-query
dc.end()
await dropped
const alive = await client.query('SELECT 1 AS v')
ok('queue survives disconnect', alive.rows[0].v === 1)

await client.end()
await server.stop()
await db.close()
console.log(`${pass} socket checks passed`)
process.exit(0)
