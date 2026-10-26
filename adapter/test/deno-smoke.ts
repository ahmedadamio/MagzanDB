// Deno smoke test — run with: deno run --allow-all test/deno-smoke.ts
// @ts-ignore: Deno resolves the .js ESM source directly
import { PGlite } from '../src/index.js'
// @ts-ignore
import { live } from '../src/live.js'

const results: Array<[string, boolean, string?]> = []
const check = (name: string, cond: boolean, extra = '') => {
  results.push([name, cond, extra])
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`)
}

// --- memory fs ---
const db = await PGlite.create('', { extensions: { live } })
check('select', (await db.query('SELECT 1+1 AS sum')).rows[0].sum === 2)
check(
  'params',
  (await db.query('SELECT $1::int + $2::int AS s', [2, 3])).rows[0].s === 5,
)
await db.exec('CREATE TABLE t (v int); INSERT INTO t VALUES (1),(2)')
check('exec+count', (await db.query('SELECT COUNT(*) c FROM t')).rows[0].c === 2)
let err: any
try {
  await db.query('SELECT * FROM nope')
} catch (e) {
  err = e
}
check('error code', err?.code === '42P01', err?.code)
const tx = await db.transaction(async (t: any) => {
  await t.query('INSERT INTO t VALUES (3)')
  return (await t.query('SELECT COUNT(*) c FROM t')).rows[0].c
})
check('transaction', tx === 3)
const d = await db.describeQuery('SELECT $1::int x', { params: [1] })
check('describeQuery', d.queryParams?.[0]?.dataTypeID === 23)
const notify: string[] = []
await db.listen('ch', (p: string) => notify.push(p))
await db.query("SELECT pg_notify('ch','hi')")
await new Promise((r) => setTimeout(r, 300))
check('notify', notify[0] === 'hi', JSON.stringify(notify))
await db.close()

// --- node:fs persistence via NODEFS (deno node-compat) ---
const dir = await Deno.makeTempDir()
const n1 = await PGlite.create(dir)
await n1.exec('CREATE TABLE p (v int); INSERT INTO p VALUES (99)')
await n1.close()
const n2 = await PGlite.create(dir)
check(
  'nodefs: persistence',
  (await n2.query('SELECT v FROM p')).rows[0].v === 99,
)
await n2.close()

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
Deno.exit(failed.length ? 1 : 0)
