// Smoke test: real Emscripten engine ← → Rust bridge session.
// Covers: initdb (memory fs), parameterized query, type codecs, error
// recovery, transactions, notifications, close.
import { PGlite, sql, identifier, raw } from '../src/index.js'

const results = []
const check = (name, cond, extra) => {
  results.push([name, !!cond, extra])
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)
}

const pg = await PGlite.create('memory://')
check('ready', pg.ready)

// basic query
let r = await pg.query('SELECT 1 as one')
check('select 1', r.rows[0].one === 1, JSON.stringify(r.rows[0]))

// parameterized query (extended protocol through the Rust session)
r = await pg.query('SELECT $1::int as v, $2::text as t', [42, 'hello'])
check('params', r.rows[0].v === 42 && r.rows[0].t === 'hello', JSON.stringify(r.rows[0]))

// types
r = await pg.query(
  "SELECT 1::bigint as bi, 1.5::numeric as num, true as b, NULL::text as n, '2024-01-01'::date as d, '9007199254740993'::bigint as big",
)
check(
  'types',
  r.rows[0].bi === 1 && // in-range int8 → number (reference semantics)
    typeof r.rows[0].big === 'bigint' && r.rows[0].big === 9007199254740993n &&
    r.rows[0].num === '1.5' &&
    r.rows[0].b === true &&
    r.rows[0].n === null &&
    r.rows[0].d instanceof Date,
  JSON.stringify(r.rows[0], (k, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v)),
)

// exec (simple protocol, multi-statement)
const multi = await pg.exec('CREATE TABLE t(a int); INSERT INTO t VALUES (1),(2)')
check('exec multi', multi.length === 2)

// error recovery: bad query then good query
let threw = false
try {
  await pg.query('SELECT * FROM does_not_exist')
} catch (e) {
  threw = true
  check('error fields', e.code === '42P01' && e.severity === 'ERROR', `${e.code} ${e.message?.slice(0, 40)}`)
}
check('error thrown', threw)
r = await pg.query('SELECT 2 as ok')
check('recovery after error', r.rows[0].ok === 2)

// transaction
await pg.transaction(async (tx) => {
  await tx.exec('INSERT INTO t VALUES (3)')
  const tr = await tx.query('SELECT COUNT(*) as c FROM t')
  check('tx count', tr.rows[0].c === 3, String(tr.rows[0].c))
})
r = await pg.query('SELECT COUNT(*) as c FROM t')
check('tx committed', r.rows[0].c === 3)

// rollback
try {
  await pg.transaction(async (tx) => {
    await tx.exec('INSERT INTO t VALUES (99)')
    throw new Error('boom')
  })
} catch (e) {}
r = await pg.query('SELECT COUNT(*) as c FROM t')
check('tx rollback', r.rows[0].c === 3)

// sql template — params + identifier + raw helpers + nested sql
r = await pg.sql`SELECT * FROM ${identifier`t`} WHERE a = ${3}`
check('sql template', r.rows.length === 1 && r.rows[0].a === 3, JSON.stringify(r.rows))
const inner = sql`a = ${1}`
r = await pg.sql`SELECT * FROM ${identifier`t`} WHERE ${inner} OR a = ${2}`
check('sql nested', r.rows.length === 2, JSON.stringify(r.rows))

// notifications (LISTEN/NOTIFY on same connection via exec)
let got = []
await pg.listen('chan1', (p) => got.push(p))
await pg.exec(`NOTIFY chan1, 'hello'`)
await new Promise((r) => setTimeout(r, 50))
check('notify', got[0] === 'hello', String(got[0]))

// rowMode array
r = await pg.query('SELECT 1 as a, 2 as b', [], { rowMode: 'array' })
check('rowMode array', Array.isArray(r.rows[0]) && r.rows[0][0] === 1 && r.rows[0][1] === 2)

// describeQuery
const desc = await pg.describeQuery('SELECT $1::int as v')
check('describe params', desc.queryParams[0].dataTypeID === 23, JSON.stringify(desc.queryParams))

await pg.close()
check('closed', pg.closed)

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
