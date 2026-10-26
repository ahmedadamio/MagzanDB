import assert from 'node:assert/strict'
import { PGlite } from '../src/index.js'
import { pgDump } from '../src/tools.js'

const db = await PGlite.create()
await db.exec(`
  CREATE TABLE t (id serial primary key, name text, created timestamptz default now());
  INSERT INTO t (name) VALUES ('alpha'), ('beta');
  CREATE VIEW v_t AS SELECT name FROM t;
`)

// plain dump
const file = await pgDump({ pg: db })
assert.equal(file.name, 'dump.sql')
const text = await file.text()
assert.ok(text.includes('CREATE TABLE public.t'), 'dump has CREATE TABLE')
assert.ok(/INSERT INTO public\.t VALUES \(1, 'alpha'/.test(text), 'dump has inserts')
assert.ok(text.includes('CREATE VIEW public.v_t'), 'dump has view')

// session still usable after dump (regression: #onData must be restored)
const r = await db.query('SELECT count(*)::int n FROM t')
assert.equal(r.rows[0].n, 2)

// dump with args (schema-qualified table only)
const file2 = await pgDump({ pg: db, args: ['-t', 'public.t'], fileName: 't.sql' })
const text2 = await file2.text()
assert.ok(text2.includes('CREATE TABLE public.t'))
assert.ok(!text2.includes('CREATE VIEW public.v_t'), 'filtered dump excludes view')

// dump into a restored instance round-trips
const db2 = await PGlite.create()
const statements = text.split('\n').filter(l => l.includes('COPY public.t'))
assert.equal(statements.length, 0, 'dump uses --inserts not COPY')
await db2.exec(text.replace(/CREATE SCHEMA public;|CREATE EXTENSION.*/g, ''))
const r2 = await db2.query('SELECT * FROM public.t ORDER BY id')
assert.deepEqual(r2.rows.map(r => r.name), ['alpha', 'beta'])

await db.close()
await db2.close()
console.log('pg_dump: all passed')
