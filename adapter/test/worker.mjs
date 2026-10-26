import { Worker } from 'worker_threads'
import { PGliteWorker } from '../src/index.js'

const w = new Worker(new URL('./test-worker.mjs', import.meta.url))
const db = await PGliteWorker.create(w, {})
console.log('ready:', db.ready, 'isLeader:', db.isLeader)
const r = await db.query('SELECT 1+1 AS sum')
console.log('query:', JSON.stringify(r.rows))
await db.exec('CREATE TABLE t (v int); INSERT INTO t VALUES (1),(2)')
console.log('exec ok')
const tx = await db.transaction(
  async (tx) => (await tx.query('SELECT COUNT(*) c FROM t')).rows[0].c,
)
console.log('tx:', tx)
const got = []
await db.listen('chan', (p) => got.push(p))
await db.query("SELECT pg_notify('chan','hi')")
await new Promise((r) => setTimeout(r, 300))
console.log('notify:', JSON.stringify(got))
const d = await db.describeQuery('SELECT $1::int x', { params: [1] })
console.log('describe params:', JSON.stringify(d.queryParams))
await db.close()
console.log('DONE')
process.exit(0)
