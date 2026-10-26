// node-postgres (pg) compatibility over the Rust-backed adapter.
import { createRequire } from 'module'
const require = createRequire(
  '/Users/ahmed/Desktop/majaz/lab/pglite/packages/pglite-node-postgres/package.json',
)
const { Pool } = require('pg')
const { PGlite } = await import('../src/index.js')
const { PGlitePgConfig } = await import('../src/pg-compat.js')

let pass = 0
const ok = (name, cond) => {
  if (!cond) throw new Error(`FAIL ${name}`)
  console.log(`ok ${name}`)
  pass++
}

const db = await PGlite.create({})
const pool = new Pool(new PGlitePgConfig({ pglite: db }))

const r = await pool.query('SELECT $1::int a, $2::text b', [42, 'hi'])
ok('param query', r.rows[0].a === 42 && r.rows[0].b === 'hi')
await pool.query('CREATE TABLE t (v int)')
await pool.query('INSERT INTO t VALUES (1),(2),(3)')
const c = await pool.query('SELECT count(*)::int n FROM t')
ok('count', c.rows[0].n === 3)
try {
  await pool.query('SELECT * FROM missing_table_xyz')
  ok('error surfaced', false)
} catch (e) {
  ok('error surfaced', e.code === '42P01')
}
await pool.end()
await db.close()
console.log(`${pass} pg-compat checks passed`)
process.exit(0)
