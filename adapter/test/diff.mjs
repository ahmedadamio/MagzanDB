// Differential test: run the same case battery against the TS reference
// (packages/pglite/dist) and the Rust-backed adapter, then deep-compare a
// canonicalized view of every result.
//
// Run: node adapter/test/diff.mjs
import assert from 'node:assert'
import { existsSync } from 'node:fs'
import { PGlite as RsPGlite, identifier as rsIdentifier, types as rsTypes } from '../src/index.js'

// The differential suite compares against a checkout of the TS reference
// (electric-sql/pglite) expected as a sibling directory. Skip cleanly when
// running from a standalone clone.
const refBase = new URL('../../../pglite/packages/', import.meta.url)
if (!existsSync(new URL('pglite/dist/index.js', refBase))) {
  console.log('diff: skipped — TS reference checkout not found at ../pglite')
  process.exit(0)
}
const refUrl = (p) => new URL(p, refBase).href
const { PGlite: TsPGlite, types: tsTypes, formatQuery: tsFormatQuery } =
  await import(refUrl('pglite/dist/index.js'))
const { identifier: tsIdentifier } = await import(
  refUrl('pglite/dist/templating.js')
)
const { serialize: tsSerialize } = await import(
  refUrl('pg-protocol/dist/index.js')
)

let pass = 0
let fail = 0

// Canonicalize a result for comparison: bigint → tag, Date → ms,
// Uint8Array → hex, NaN → tag, plain objects/arrays recur.
function canon(v) {
  if (typeof v === 'bigint') return { $bigint: v.toString() }
  if (typeof v === 'number' && Number.isNaN(v)) return { $num: 'NaN' }
  if (v instanceof Date) return { $date: v.getTime() }
  if (v instanceof Uint8Array) return { $bytes: Buffer.from(v).toString('hex') }
  if (v instanceof Blob) return { $blob: true }
  if (Array.isArray(v)) return v.map(canon)
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, canon(x)]))
  }
  return v
}

function canonResult(r) {
  return canon({
    rows: r.rows,
    fields: r.fields?.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
    affectedRows: r.affectedRows,
  })
}

function canonError(e) {
  return canon({
    name: e?.name,
    message: e?.message,
    severity: e?.severity,
    code: e?.code,
    detail: e?.detail,
    hint: e?.hint,
    position: e?.position,
    routine: e?.routine,
    column: e?.column,
    dataType: e?.dataType,
    constraint: e?.constraint,
    file: e?.file,
    line: e?.line,
  })
}

// helpers is per-implementation (template part objects aren't portable)
async function check(name, fn) {
  try {
    const [t, r] = await Promise.all([
      fn(tsdb, { identifier: tsIdentifier }),
      fn(rsdb, { identifier: rsIdentifier }),
    ])
    assert.deepStrictEqual(canon(t), canon(r))
    pass++
    console.log(`  ok ${name}`)
  } catch (e) {
    fail++
    console.log(`FAIL ${name}: ${e.message}`)
  }
}

async function checkErr(name, fn) {
  const run = async (db) => {
    try {
      return { ok: canon(await fn(db)) }
    } catch (e) {
      return { err: canonError(e) }
    }
  }
  try {
    const t = await run(tsdb)
    const r = await run(rsdb)
    assert.deepStrictEqual(r, t)
    pass++
    console.log(`  ok ${name}`)
  } catch (e) {
    fail++
    console.log(`FAIL ${name}: ${e.message}`)
  }
}

const tsdb = await TsPGlite.create()
const rsdb = await RsPGlite.create()

// For cases that need constructor options or fresh instances.
async function withDbs(name, options, fn) {
  const t = await TsPGlite.create(options?.ts ?? options ?? {})
  const r = await RsPGlite.create(options?.rs ?? options ?? {})
  try {
    const tr = await fn(t, { identifier: tsIdentifier })
    const rr = await fn(r, { identifier: rsIdentifier })
    try {
      assert.deepStrictEqual(canon(tr), canon(rr))
      pass++
      console.log(`  ok ${name}`)
    } catch (e) {
      fail++
      console.log(`FAIL ${name}: ${e.message}`)
    }
  } finally {
    await t.close?.()
    await r.close?.()
  }
}

console.log('== basic ==')
await check('select literal', (db) => db.query('SELECT 1 as x'))
await check('multi-result exec', (db) => db.exec('SELECT 1; SELECT 2').then((rs) => rs.map(canonResult)))
await check('empty query', (db) => db.query(''))
await check('create+insert+select', async (db) => {
  await db.exec('CREATE TABLE t(a int, b text);')
  await db.query('INSERT INTO t VALUES ($1, $2), ($3, $4)', [1, 'one', 2, 'two'])
  return canonResult(await db.query('SELECT * FROM t ORDER BY a'))
})

console.log('== types ==')
const typeCases = [
  ['bool', 'SELECT true as v'],
  ['int2', "SELECT 5::int2 as v"],
  ['int4', "SELECT 5::int4 as v"],
  ['int8 in-range', 'SELECT 9007199254740991::int8 as v'],
  ['int8 out-of-range', 'SELECT 9007199254740993::int8 as v'],
  ['float4', 'SELECT 1.5::float4 as v'],
  ['float8', 'SELECT 1.5::float8 as v'],
  ['numeric', 'SELECT 1.50::numeric as v'],
  ['text', "SELECT 'héllo'::text as v"],
  ['varchar', "SELECT 'abc'::varchar as v"],
  ['json', 'SELECT \'{"a":1}\'::json as v'],
  ['jsonb', 'SELECT \'{"a":1}\'::jsonb as v'],
  ['bytea', "SELECT '\\x0102ff'::bytea as v"],
  ['date', "SELECT '2021-03-04'::date as v"],
  ['timestamp', "SELECT '2021-03-04 05:06:07'::timestamp as v"],
  ['timestamptz', "SELECT '2021-03-04 05:06:07+00'::timestamptz as v"],
  ['uuid', "SELECT 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid as v"],
  ['interval', "SELECT '1 day 02:00:00'::interval as v"],
  ['int array', 'SELECT ARRAY[1,2,3]::int[] as v'],
  ['text array', "SELECT ARRAY['a','b']::text[] as v"],
  ['nested array', 'SELECT ARRAY[[1,2],[3,4]]::int[] as v'],
  ['null', 'SELECT NULL::int as v'],
]
for (const [name, q] of typeCases) {
  await check(name, (db) => db.query(q))
}

console.log('== params ==')
await check('param number', (db) => db.query('SELECT $1::int as v', [42]))
await check('param bigint', (db) => db.query('SELECT $1::int8 as v', [9007199254740993n]))
await check('param string', (db) => db.query('SELECT $1::text as v', ['hello']))
await check('param bool', (db) => db.query('SELECT $1::bool as v', [true]))
await check('param null', (db) => db.query('SELECT $1::int as v', [null]))
await check('param undefined', (db) => db.query('SELECT $1::int as v', [undefined]))
await check('param date', (db) => db.query('SELECT $1::timestamptz as v', [new Date(0)]))
await check('param bytes', (db) => db.query('SELECT $1::bytea as v', [new Uint8Array([1, 2, 3])]))
await check('param json object', (db) => db.query('SELECT $1::jsonb as v', [{ a: 1 }]))
await check('param int array', (db) => db.query('SELECT $1::int[] as v', [[1, 2, 3]]))
await check('param text array', (db) => db.query('SELECT $1::text[] as v', [['x', 'y']]))
await check('param nested array', (db) => db.query('SELECT $1::int[] as v', [[[1, 2], [3, 4]]]))
await checkErr('param non-rectangular array errors', (db) =>
  db.query('SELECT $1::int[] as v', [[[1, 2], [3]]]),
)
await check('param float', (db) => db.query('SELECT $1::float8 as v', [1.25]))
await check('param NaN', (db) => db.query("SELECT $1::text as v", [NaN]))
await check('many params', (db) =>
  db.query('SELECT $1::int a, $2::text b, $3::bool c', [1, 'x', false]),
)

console.log('== rowMode ==')
await check('rowMode array', (db) =>
  db.query('SELECT 1 as a, 2 as b', [], { rowMode: 'array' }),
)

console.log('== errors ==')
await checkErr('syntax error', (db) => db.query('SELEC'))
await checkErr('undefined table', (db) => db.query('SELECT * FROM nope'))
await checkErr('dup key', async (db) => {
  await db.exec('CREATE TABLE u(x int primary key);')
  await db.query('INSERT INTO u VALUES (1)')
  return db.query('INSERT INTO u VALUES (1)')
})
await checkErr('division by zero', (db) => db.query('SELECT 1/0'))
await check('recovery after error', async (db) => {
  try { await db.query('SELECT * FROM nope2') } catch {}
  return canonResult(await db.query('SELECT 2 as ok'))
})

console.log('== transactions ==')
await check('tx commit', async (db) => {
  await db.exec('DROP TABLE IF EXISTS tx; CREATE TABLE tx(v int);')
  await db.transaction(async (tx) => {
    await tx.query('INSERT INTO tx VALUES (1)')
    await tx.query('INSERT INTO tx VALUES (2)')
  })
  return canonResult(await db.query('SELECT count(*)::int c FROM tx'))
})
await check('tx rollback', async (db) => {
  try {
    await db.transaction(async (tx) => {
      await tx.query('INSERT INTO tx VALUES (99)')
      throw new Error('boom')
    })
  } catch {}
  return canonResult(await db.query('SELECT count(*)::int c FROM tx WHERE v = 99'))
})
await checkErr('tx error propagates + rollback', async (db) => {
  try {
    await db.transaction(async (tx) => {
      await tx.query('INSERT INTO tx VALUES (98)')
      await tx.query('SELECT * FROM does_not_exist')
    })
    return 'no-throw'
  } catch (e) {
    return { code: e.code }
  }
})
await check('tx rollback state', (db) =>
  db.query('SELECT count(*)::int c FROM tx WHERE v = 98'),
)

console.log('== templating ==')
await check('db.sql template', async (db) =>
  canonResult(await db.sql`SELECT ${5}::int v`),
)
await check('identifier tag', async (db, { identifier }) =>
  canonResult(await db.sql`SELECT 1 as ${identifier`my col`}`),
)
await check('nested sql tag', async (db, { identifier }) =>
  canonResult(await db.sql`SELECT * FROM (VALUES (1),(2)) t(a) WHERE a = ${2}`),
)

console.log('== notifications ==')
await check('notify', async (db) => {
  const got = []
  await db.listen('chan', (payload) => got.push(payload))
  await db.query("NOTIFY chan, 'hello'")
  await new Promise((r) => setTimeout(r, 50))
  return got
})

console.log('== describe ==')
await check('describeQuery', async (db) => {
  const d = await db.describeQuery('SELECT $1::int a, $2::text b', [])
  return canon({
    params: d.queryParams?.map((p) => ({
      dataTypeID: p.dataTypeID,
      hasSer: typeof p.serializer === 'function',
    })),
    fields: d.resultFields?.map((f) => ({
      name: f.name,
      dataTypeID: f.dataTypeID,
      hasPar: typeof f.parser === 'function',
    })),
  })
})

console.log('== affectedRows ==')
await check('insert/update/delete counts', async (db) => {
  await db.exec('DROP TABLE IF EXISTS cnt; CREATE TABLE cnt(v int);')
  const ins = canonResult(await db.query('INSERT INTO cnt VALUES (1),(2),(3)'))
  const upd = canonResult(await db.query('UPDATE cnt SET v = v + 1 WHERE v < 3'))
  const del = canonResult(await db.query('DELETE FROM cnt WHERE v = 4'))
  return { ins: ins.affectedRows, upd: upd.affectedRows, del: del.affectedRows }
})
await check('merge delete', async (db) => {
  await db.exec(`DROP TABLE IF EXISTS employees;
    CREATE TABLE employees (id SERIAL PRIMARY KEY, name TEXT, department TEXT, salary NUMERIC);
    INSERT INTO employees (id, name, department, salary) VALUES
      (1, 'Alice', 'Engineering', 75000),
      (2, 'Bob', 'Sales', 50000),
      (3, 'Charlie', 'Engineering', 80000);
    CREATE TEMP TABLE employees_updates (id INT, name TEXT, department TEXT, salary NUMERIC);
    INSERT INTO employees_updates VALUES
      (2, 'Bob', 'Sales', 55000),
      (3, 'Charlie', 'Product', 80000),
      (4, 'Diana', 'Engineering', 70000);`)
  const res = await db.exec(`MERGE INTO employees AS target
    USING employees_updates AS source
    ON target.id = source.id
    WHEN MATCHED THEN DELETE`)
  return res[0].affectedRows
})

console.log('== parity from basic.test.ts ==')
await check('same param used twice', async (db) => {
  await db.exec(`DROP TABLE IF EXISTS sp; CREATE TABLE sp (a text, b text);`)
  await db.query('INSERT INTO sp VALUES ($1, $1)', ['Duck'])
  return canonResult(
    await db.query('SELECT * FROM sp WHERE a = $1 AND b = $1', ['Duck']),
  )
})
await check('arrays with NULL elements', async (db) => {
  await db.exec('DROP TABLE IF EXISTS nt; CREATE TABLE nt (s text, arr text[]);')
  for (const arr of [
    [null, 'hello', 'NULL'],
    ['NULL', null, 'NULL'],
    ['NULL', 'hello', null],
    [null, null, null],
  ]) {
    await db.query('INSERT INTO nt VALUES ($1, $2)', [null, arr])
  }
  const res = await db.query('SELECT arr FROM nt')
  return res.rows.map((r) => r.arr)
})
await check('int array with NULLs', async (db) => {
  await db.exec('DROP TABLE IF EXISTS ni; CREATE TABLE ni (arr int[]);')
  await db.query('INSERT INTO ni VALUES ($1)', [[null, 123, 0]])
  return (await db.query('SELECT arr FROM ni')).rows[0].arr
})
await check('bigint via json_to_recordset', async (db) => {
  await db.exec('DROP TABLE IF EXISTS mb; CREATE TABLE mb (id bigint);')
  await db.query(
    'INSERT INTO mb SELECT x.* FROM json_to_recordset($1) as x(id bigint)',
    [[{ id: 9007199254740992n }, { id: 9007199254740993n }]],
  )
  return (await db.query('SELECT * FROM mb ORDER BY id')).rows
})
await check('untyped params come back text', async (db) =>
  canonResult(
    await db.query('select $1 as number, $2 as date, $3 as bool', [
      42,
      new Date('2024-01-15T12:34:56.000Z'),
      true,
    ]),
  ),
)
await check('bytea via exec', async (db) =>
  canonResult((await db.exec(`SELECT convert_to('abc', 'LATIN1')`))[0]),
)
await check('default db/user/role', async (db) =>
  (await db.exec('SELECT current_database() db, current_user u, current_role r'))[0].rows,
)
await check('version() mentions PGlite', async (db) => {
  const v = (await db.query('select version() v')).rows[0].v
  return /\PGlite \d+\.\d+\.\d+\b/.test(v)
})
await check('explain gather off', async (db) => {
  await db.exec('DROP TABLE IF EXISTS big; CREATE TABLE big (id serial primary key, val text);')
  await db.exec(`INSERT INTO big (val) SELECT md5(i::text) FROM generate_series(1, 5000) i;`)
  const plan = await db.query('EXPLAIN SELECT COUNT(*) FROM big')
  return plan.rows.every((r) => !r['QUERY PLAN'].includes('Gather'))
})
await checkErr('tx handle closed after rollback', async (db) => {
  let tx
  await db.transaction(async (t) => {
    tx = t
    await t.rollback()
  })
  try {
    await tx.query('SELECT 1')
    return 'no-throw'
  } catch (e) {
    return { closed: tx.closed, msg: e.message }
  }
})
await checkErr('tx handle closed after failed cb', async (db) => {
  let tx
  try {
    await db.transaction(async (t) => {
      tx = t
      throw new Error('boom')
    })
  } catch {}
  try {
    await tx.exec('SELECT 1')
    return 'no-throw'
  } catch (e) {
    return { closed: tx.closed, msg: e.message }
  }
})
await withDbs('custom parser+serializer', {
  ts: { parsers: { 1700: (x) => BigInt(x) }, serializers: { 1700: (x) => x.toString() } },
  rs: { parsers: { 1700: (x) => BigInt(x) }, serializers: { 1700: (x) => x.toString() } },
}, async (db) => {
  await db.exec('CREATE TABLE n (id serial primary key, v numeric);')
  await db.query('INSERT INTO n (v) VALUES ($1)', [100n])
  return canonResult(await db.query('SELECT * FROM n'))
})
await withDbs('per-query parser override', {}, async (db) => {
  const r = await db.query('SELECT 42::numeric v', [], {
    parsers: { 1700: (x) => `parsed:${x}` },
  })
  return r.rows
})
await withDbs('startParams application_name', {
  ts: { startParams: [...TsPGlite.defaultStartParams, '-c', 'application_name=diffapp'] },
  rs: { startParams: [...(RsPGlite.defaultStartParams ?? TsPGlite.defaultStartParams), '-c', 'application_name=diffapp'] },
}, async (db) =>
  (await db.exec(`SELECT setting FROM pg_settings WHERE name='application_name'`))[0].rows,
)
await withDbs('postgresqlconf', {
  ts: { postgresqlconf: [`application_name = 'confapp'`] },
  rs: { postgresqlconf: [`application_name = 'confapp'`] },
}, async (db) => (await db.query('SHOW application_name')).rows)
await check('failed statements recoverable x10', async (db) => {
  for (let i = 0; i < 10; i++) await db.query('SELECT 1/0').catch(() => {})
  return canonResult(await db.query('SELECT 1 ok'))
})
await check('COPY to/from blob', async (db) => {
  await db.exec(`DROP TABLE IF EXISTS cp;
    CREATE TABLE cp (id serial primary key, t text);
    INSERT INTO cp (t) VALUES ('test'), ('test2');`)
  const copyTo = await db.query("COPY cp TO '/dev/blob' WITH (FORMAT csv)")
  const csv = await copyTo.blob.text()
  await db.exec('DROP TABLE IF EXISTS cp2; CREATE TABLE cp2 (id serial primary key, t text);')
  const copyFrom = await db.query("COPY cp2 FROM '/dev/blob' WITH (FORMAT csv)", [], {
    blob: new Blob([csv]),
  })
  const sel = await db.query('SELECT * FROM cp2')
  return {
    csv,
    toAffected: copyTo.affectedRows,
    fromAffected: copyFrom.affectedRows,
    rows: canon(sel.rows),
  }
})

console.log('== execProtocol ==')
function msgNames(msgs) {
  return msgs.map((m) => m.name ?? m.$name)
}
function rawTypes(data) {
  const buf = Buffer.from(data)
  const types = []
  for (let off = 0; off < buf.length; ) {
    types.push(String.fromCharCode(buf[off]))
    off += 1 + buf.readInt32BE(off + 1)
  }
  return types.join(',')
}
await check('execProtocol simple query', async (db) => {
  const r = await db.execProtocol(tsSerialize.query('SELECT 1'))
  return { names: msgNames(r.messages), dataLen: r.data.length }
})
await check('execProtocol extended sequence', async (db) => {
  const seq = [
    ['parse', tsSerialize.parse({ text: 'SELECT $1' })],
    ['bind', tsSerialize.bind({ values: ['1'] })],
    ['describe', tsSerialize.describe({ type: 'P' })],
    ['execute', tsSerialize.execute({})],
    ['sync', tsSerialize.sync()],
  ]
  const out = {}
  for (const [k, m] of seq) {
    out[k] = msgNames((await db.execProtocol(m)).messages)
  }
  return out
})
await check('execProtocol error no-throw', async (db) => {
  const r = await db.execProtocol(tsSerialize.query('invalid sql'), {
    throwOnError: false,
  })
  return msgNames(r.messages)
})
await checkErr('execProtocol error throws', async (db) => {
  try {
    await db.execProtocol(tsSerialize.query('invalid sql'))
    return 'no-throw'
  } catch (e) {
    return { code: e.code, msg: e.message.slice(0, 40) }
  }
})
await check('execProtocol raw error recovery: parse', async (db) => {
  const data = await db.execProtocolRaw(
    Buffer.concat([tsSerialize.parse({ text: 'SELECT FROM' }), tsSerialize.sync()]),
  )
  return rawTypes(data)
})
await check('execProtocol raw error recovery: bind', async (db) => {
  await db.execProtocolRaw(
    Buffer.concat([tsSerialize.parse({ text: 'SELECT $1::int' }), tsSerialize.sync()]),
  )
  const data = await db.execProtocolRaw(
    Buffer.concat([tsSerialize.bind({ values: ['not-an-integer'] }), tsSerialize.sync()]),
  )
  return rawTypes(data)
})
await check('execProtocol raw error recovery: execute', async (db) => {
  await db.exec('DROP TABLE IF EXISTS uq; CREATE TABLE uq (id int primary key); INSERT INTO uq VALUES (1)')
  const data = await db.execProtocolRaw(
    Buffer.concat([
      tsSerialize.parse({ text: 'INSERT INTO uq VALUES ($1)' }),
      tsSerialize.bind({ values: ['1'] }),
      tsSerialize.describe({ type: 'P' }),
      tsSerialize.execute({}),
      tsSerialize.sync(),
    ]),
  )
  return rawTypes(data)
})
await check('execProtocol bytes identical', async (db) => {
  const data = await db.execProtocolRaw(tsSerialize.query('SELECT 1 as a'))
  return Buffer.from(data).toString('base64')
})

console.log('== types namespace ==')
// Compare types.serializers / parseType between the two type tables.
async function checkTypes(name, fn) {
  try {
    const t = await fn(tsTypes)
    const r = await fn(rsTypes)
    assert.deepStrictEqual(canon(t), canon(r))
    pass++
    console.log(`  ok ${name}`)
  } catch (e) {
    fail++
    console.log(`FAIL ${name}: ${e.message}`)
  }
}
await checkTypes('serializers[25]', (t) => t.serializers[25]('test'))
await checkTypes('serializers[25] number', (t) => t.serializers[25](1))
await checkTypes('serializers[0]', (t) => [t.serializers[0](1), t.serializers[0](1.1)])
await checkTypes('serializers[20]', (t) => t.serializers[20](1n))
await checkTypes('bool literals', (t) =>
  ['true', 't', 'yes', 'y', 'on', '1', 'TRUE', ' t ', 'false', 'f', 'no', 'n', 'off', '0', 'FALSE', ' f '].map(
    (s) => t.serializers[16](s),
  ),
)
await checkTypes('bool from number', (t) => [t.serializers[16](1), t.serializers[16](0)])
await checkTypes('bool throws', (t) =>
  [2, -1, NaN, 'ture', 'maybe', '', {}].map((v) => {
    try {
      return t.serializers[16](v)
    } catch (e) {
      return 'ERR'
    }
  }),
)
await checkTypes('date serializer', (t) => [
  t.serializers[1184](new Date('2021-01-01T00:00:00.000Z')),
  t.serializers[1184](1672531200000),
  t.serializers[1184]('2021-01-01T00:00:00.000Z'),
])
await checkTypes('date throws', (t) => {
  try {
    return t.serializers[1184](true)
  } catch {
    return 'ERR'
  }
})
await checkTypes('json serializer', (t) => [
  t.serializers[114]({ test: 1 }),
  t.serializers[114]('{"test":1}'),
])
await checkTypes('bytea serializer', (t) => t.serializers[17](Uint8Array.from([1, 2, 3])))
await checkTypes('bytea throws', (t) => {
  try {
    return t.serializers[17](1)
  } catch {
    return 'ERR'
  }
})
await checkTypes('parseType', (t) => [
  t.parseType('test', 0),
  t.parseType('test', 1043),
  t.parseType('1', 21),
  t.parseType('1', 23),
  t.parseType('1', 26),
  t.parseType('1.1', 700),
  t.parseType('1.1', 701),
  t.parseType('1', 20),
  t.parseType('{"test":1}', 114),
  t.parseType('{"test":1}', 3802),
  t.parseType('t', 16),
  t.parseType('2021-01-01', 1082),
  t.parseType('2021-01-01T12:00:00', 1114),
  t.parseType('2021-01-01T12:00:00', 1184),
  t.parseType('\\x010203', 17),
  t.parseType(null, 23),
])

console.log('== notify variants ==')
await check('listen + unlisten', async (db) => {
  const got = []
  const unsub = await db.listen('c1', (p) => got.push(p))
  await db.exec("NOTIFY c1, 'a'")
  await unsub()
  await db.exec("NOTIFY c1, 'b'")
  await new Promise((r) => setTimeout(r, 50))
  return got
})
await check('onNotification', async (db) => {
  const got = []
  const off = db.onNotification((chan, payload) => got.push([chan, payload]))
  await db.exec('LISTEN ch_on')
  await db.exec("NOTIFY ch_on, 'x'")
  await new Promise((r) => setTimeout(r, 50))
  off?.()
  return got
})
await check('listen case folding', async (db) => {
  const got = []
  await db.listen('FoldedChan', (p) => got.push(['F', p]))
  await db.exec(`NOTIFY foldedchan, 'p1'`)
  await db.exec(`NOTIFY FoldedChan, 'p2'`)
  await new Promise((r) => setTimeout(r, 50))
  return got
})
await check('listen quoted channel', async (db) => {
  const got = []
  await db.listen('"CaSESEnsiTIvE"', (p) => got.push(p))
  await db.exec(`NOTIFY "CaSESEnsiTIvE", 'q1'`)
  await db.exec(`NOTIFY casesensitive, 'no'`)
  await new Promise((r) => setTimeout(r, 50))
  return got
})
await checkErr('listen unquoted spaces rejects', async (db) => {
  try {
    await db.listen('Unquoted Channel With Spaces', () => {})
    return 'no-throw'
  } catch (e) {
    return { msg: e.message.slice(0, 60) }
  }
})

console.log('== describeQuery variants ==')
await check('describeQuery params+fields', async (db) => {
  await db.exec(`DROP TABLE IF EXISTS users;
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, age INTEGER, active BOOLEAN)`)
  const d = await db.describeQuery(
    'SELECT name, age FROM users WHERE id = $1 AND active = $2',
  )
  return canon({
    params: d.queryParams.map((p) => ({
      oid: p.dataTypeID,
      ser: typeof p.serializer === 'function',
    })),
    fields: d.resultFields.map((f) => ({
      name: f.name,
      oid: f.dataTypeID,
      par: typeof f.parser === 'function',
    })),
  })
})
await check('describeQuery no params', async (db) => {
  const d = await db.describeQuery('SELECT 1')
  return canon({ params: d.queryParams.length, fields: d.resultFields.map((f) => f.dataTypeID) })
})
await check('describeQuery INSERT', async (db) => {
  await db.exec('DROP TABLE IF EXISTS ins; CREATE TABLE ins (id INTEGER PRIMARY KEY, value TEXT)')
  const d = await db.describeQuery('INSERT INTO ins (id, value) VALUES ($1, $2)')
  return canon({
    params: d.queryParams.map((p) => p.dataTypeID),
    fields: d.resultFields.length,
  })
})
await checkErr('describeQuery invalid', async (db) => {
  try {
    await db.describeQuery('SELECT * FROM nonexistent_table_xyz')
    return 'no-throw'
  } catch (e) {
    return { code: e.code, msg: /relation "nonexistent_table_xyz" does not exist/.test(e.message) }
  }
})

console.log('== array types (enum) ==')
await checkErr('enum array errors pre-refresh', async (db) => {
  await db.exec(`DROP TYPE IF EXISTS mood CASCADE;
    CREATE TYPE mood AS ENUM ('sad', 'happy');
    DROP TABLE IF EXISTS et; CREATE TABLE et (id serial primary key, moods mood[]);`)
  try {
    await db.query('INSERT INTO et (moods) VALUES ($1)', [['sad', 'happy']])
    return 'no-throw'
  } catch (e) {
    return { msg: e.message.slice(0, 50) }
  }
})
await check('enum array works post-refresh', async (db) => {
  await db.refreshArrayTypes()
  await db.query('INSERT INTO et (moods) VALUES ($1)', [['sad', 'happy']])
  return canonResult(await db.query('SELECT * FROM et ORDER BY id DESC LIMIT 1'))
})
await check('refreshArrayTypes idempotent keys', async (db) => {
  const s0 = Object.keys(db.serializers).length
  const p0 = Object.keys(db.parsers).length
  await db.refreshArrayTypes()
  const s1 = Object.keys(db.serializers).length
  const p1 = Object.keys(db.parsers).length
  await db.refreshArrayTypes()
  return { s0, p0, s1, p1, s2: Object.keys(db.serializers).length, p2: Object.keys(db.parsers).length }
})

console.log('== extensions ==')
const { uuid_ossp } = await import(
  refUrl('pglite/dist/contrib/uuid_ossp.js')
)
const { citext } = await import(refUrl('pglite/dist/contrib/citext.js'))
await withDbs('uuid-ossp', {
  ts: { extensions: { uuid_ossp } },
  rs: { extensions: { uuid_ossp } },
}, async (db) => {
  await db.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')
  return (await db.query('SELECT uuid_generate_v4() IS NOT NULL ok')).rows
})
await withDbs('citext', {
  ts: { extensions: { citext } },
  rs: { extensions: { citext } },
}, async (db) => {
  await db.query('CREATE EXTENSION IF NOT EXISTS citext')
  await db.exec('DROP TABLE IF EXISTS ci; CREATE TABLE ci (v citext); INSERT INTO ci VALUES (\'AbC\')')
  return (await db.query("SELECT * FROM ci WHERE v = 'abc'")).rows
})

console.log('== live queries ==')
const { live: tsLive } = await import(refUrl('pglite/dist/live/index.js'))
import { live as rsLive } from '../src/live.js'
await withDbs('live.query initial + insert change', {
  ts: { extensions: { live: tsLive } },
  rs: { extensions: { live: rsLive } },
}, async (db) => {
  await db.exec('CREATE TABLE t (id serial primary key, v int); INSERT INTO t (v) VALUES (1),(2);')
  const changes = []
  const q = await db.live.query('SELECT * FROM t ORDER BY id', [], (res) => changes.push(res.rows))
  const initial = q.initialResults.rows
  await db.query('INSERT INTO t (v) VALUES (3)')
  await new Promise((r) => setTimeout(r, 200))
  await q.unsubscribe()
  return { initial, changes }
})

console.log('== formatQuery ==')
import { formatQuery as rsFormatQuery } from '../src/index.js'
{
  const t = await TsPGlite.create()
  const r = await RsPGlite.create()
  try {
    for (const db of [t, r]) {
      await db.exec(`CREATE TABLE ft (id SERIAL PRIMARY KEY, b BOOLEAN, n INTEGER, s VARCHAR, j JSONB)`)
    }
    const cases = [
      ['bool', 'SELECT * FROM ft WHERE b = $1;', [true]],
      ['num', 'SELECT * FROM ft WHERE n = $1;', [1]],
      ['str', 'SELECT * FROM ft WHERE s = $1;', ["it's"]],
      ['out-of-order', 'SELECT * FROM ft WHERE s = $2 AND id = $1;', [1, 'test']],
      ['repeated', 'SELECT * FROM ft WHERE s = $1 OR s = $1;', ['x']],
      ['json', 'SELECT * FROM ft WHERE j = $1;', [{ test: 'test' }]],
    ]
    for (const [label, q, p] of cases) {
      const [ft, fr] = [await tsFormatQuery(t, q, p), await rsFormatQuery(r, q, p)]
      try {
        assert.deepStrictEqual(canon(ft), canon(fr))
        console.log(`  ok format ${label}`)
        pass++
      } catch (e) {
        console.log(`  FAIL format ${label}: ${e.message}`)
        fail++
      }
    }
  } finally {
    await t.close()
    await r.close()
  }
}

console.log('== SQL features (triggers/plpgsql/xml/user) ==')
await check('plpgsql function', async (db) => {
  await db.exec(`CREATE OR REPLACE FUNCTION plp(x int) RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN x * 2; END; $$;`)
  return (await db.query('SELECT plp(21) v')).rows
})
await check('trigger fires on insert', async (db) => {
  await db.exec(`
    CREATE TABLE trig (v int);
    CREATE TABLE triglog (v int);
    CREATE FUNCTION trig_fn() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN INSERT INTO triglog VALUES (NEW.v); RETURN NEW; END; $$;
    CREATE TRIGGER trg AFTER INSERT ON trig FOR EACH ROW EXECUTE FUNCTION trig_fn();
    INSERT INTO trig VALUES (5);
  `)
  return (await db.query('SELECT * FROM triglog')).rows
})
await check('xml type roundtrip', async (db) => {
  return (await db.query(`SELECT '<a><b>x</b></a>'::xml v`)).rows
})
await check('xmlelement/xpath', async (db) => {
  return (await db.query(`SELECT xpath('/a/b/text()', '<a><b>hi</b></a>') v`)).rows
})
await check('current_user/roles', async (db) => {
  return {
    user: (await db.query('SELECT current_user u')).rows,
    roles: (await db.query('SELECT current_role r')).rows,
  }
})
await check('CTE + window fn', async (db) => {
  return (await db.query(
    `WITH s AS (SELECT generate_series(1,5) v)
     SELECT v, row_number() OVER (ORDER BY v DESC) rn FROM s ORDER BY v`,
  )).rows
})
await check('generate_series + agg', async (db) => {
  return (await db.query(
    `SELECT count(*)::int c, sum(v)::int s, min(v) mn, max(v) mx FROM generate_series(1,10) v`,
  )).rows
})
await check('query-sizes: 1mb text roundtrip', async (db) => {
  const big = 'x'.repeat(1024 * 1024)
  const r = await db.query('SELECT $1::text v', [big])
  return r.rows[0].v.length
})
await check('largeobjects via lo_*', async (db) => {
  await db.exec(`CREATE TABLE lob (oid oid); INSERT INTO lob SELECT lo_create(0)`)
  const o = (await db.query('SELECT oid FROM lob')).rows[0].oid
  const w = await db.query('SELECT lo_put($1, 0, $2) n', [o, Buffer.from('hello')])
  const rd = await db.query('SELECT lo_get($1) d', [o])
  return { oid: typeof o, written: w.rows, data: rd.rows }
})

console.log('== instantiation / clone / drop-database ==')
{
  // direct-constructor variant — both impls accept new PGlite(opts)
  const t = new TsPGlite({})
  const r = new RsPGlite({})
  try {
    await t.waitReady
    await r.waitReady
    const [qt, qr] = [
      (await t.query('SELECT 1 one')).rows,
      (await r.query('SELECT 1 one')).rows,
    ]
    assert.deepStrictEqual(canon(qt), canon(qr))
    console.log('  ok direct constructor')
    pass++
    const dbg = t.debug === r.debug
    assert.ok(dbg)
    console.log('  ok debug field')
    pass++
  } finally {
    await t.close()
    await r.close()
  }
}
await check('clone() independent divergence', async (db) => {
  await db.exec('DROP TABLE IF EXISTS cl; CREATE TABLE cl (v int); INSERT INTO cl VALUES (1)')
  const c2 = await db.clone()
  await c2.query('INSERT INTO cl VALUES (2)')
  const r1 = (await db.query('SELECT count(*)::int n FROM cl')).rows
  const r2 = (await c2.query('SELECT count(*)::int n FROM cl')).rows
  await c2.close()
  return { r1, r2 }
})
await check('drop database + recreate', async (db) => {
  await db.exec('DROP TABLE IF EXISTS dd2; CREATE TABLE dd2 (v int); INSERT INTO dd2 VALUES (1)')
  await db.exec('DROP DATABASE IF EXISTS mypostgres')
  await db.exec('CREATE DATABASE mypostgres TEMPLATE template1')
  return (await db.query('SELECT * FROM dd2')).rows
})
await check('MessageContext bounded after big literals', async (db) => {
  const blob = JSON.stringify({ padding: 'x'.repeat(50 * 1024) })
  await db.exec('DROP TABLE IF EXISTS lk; CREATE TABLE lk (j jsonb)')
  for (let i = 0; i < 40; i++) {
    await db.exec(`INSERT INTO lk (j) VALUES ('${blob}')`)
  }
  const mem = await db.query(
    `SELECT used_bytes FROM pg_backend_memory_contexts WHERE name = 'MessageContext' ORDER BY level LIMIT 1`,
  )
  return { used_bytes_small: mem.rows[0].used_bytes < 10 * 1024 * 1024 }
})
await check('initdb timezone is UTC', async (db) => {
  return {
    tz: (await db.query('SHOW TimeZone')).rows,
    now_utc: (await db.query(`SELECT '2026-07-01 12:00:00+00'::timestamptz t`)).rows,
  }
})

console.log('== debounceMutex (utils) ==')
import { debounceMutex } from '../src/utils.js'
{
  // utils.test.ts parity: first and last calls run, middle resolves undefined
  const results = []
  const delay = (ms) => new Promise((r) => setTimeout(r, ms))
  const fn = async (n) => { await delay(10); results.push(n); return n }
  const debounced = debounceMutex(fn)
  const rv = await Promise.all([debounced(1), debounced(2), debounced(3)])
  try {
    assert.deepStrictEqual(results, [1, 3])
    assert.deepStrictEqual(rv, [1, undefined, 3])
    console.log('  ok debounceMutex cancel-middle')
    pass++
  } catch (e) {
    console.log(`  FAIL debounceMutex: ${e.message}`)
    fail++
  }
}

console.log('== dumpDataDir / loadDataDir ==')
await check('dump + load roundtrip', async (db) => {
  await db.exec('DROP TABLE IF EXISTS dd; CREATE TABLE dd (v int); INSERT INTO dd VALUES (7)')
  const dump = await db.dumpDataDir('none')
  const db2 =
    db === tsdb
      ? await TsPGlite.create({ loadDataDir: dump })
      : await RsPGlite.create({ loadDataDir: dump })
  try {
    return canonResult(await db2.query('SELECT * FROM dd'))
  } finally {
    await db2.close?.()
  }
})

console.log('== full-text search ==')
await check('fts: tsvector/tsquery match', async (db) => {
  await db.exec(`CREATE TABLE docs (id int, body text);
    INSERT INTO docs VALUES (1, 'the quick brown fox'), (2, 'lazy dogs sleep')`)
  return canonResult(await db.query(
    `SELECT id FROM docs WHERE to_tsvector('english', body) @@ to_tsquery('english', 'fox')`,
  ))
})
await check('fts: ts_rank + headline', async (db) => {
  const r = await db.query(
    `SELECT ts_rank(to_tsvector('english', 'a b c a'), to_tsquery('a')) AS r`,
  )
  return { rankPositive: r.rows[0].r > 0 }
})

console.log('== initdb fs option ==')
{
  // User-provided fs must init once — the inner initdb instance uses a
  // scratch FS, not the user's (both sides should count exactly 1).
  for (const [label, PG] of [['ts', TsPGlite], ['rs', RsPGlite]]) {
    const { MemoryFS } =
      label === 'ts'
        ? await import('../../../pglite/packages/pglite/dist/index.js')
        : await import('../src/index.js')
    class CountingFS extends MemoryFS {
      constructor() {
        super()
        this.initCount = 0
      }
      async init(...args) {
        this.initCount++
        return super.init(...args)
      }
    }
    const fs = new CountingFS()
    const pg = await PG.create({ fs })
    await pg.exec('CREATE TABLE t (id int); INSERT INTO t VALUES (1)')
    const res = await pg.query('SELECT id FROM t')
    await pg.close()
    if (fs.initCount === 1 && res.rows[0].id === 1) {
      pass++
      console.log(`  ok initdb fs option (${label}): initCount=${fs.initCount}`)
    } else {
      fail++
      console.log(`  FAIL initdb fs option (${label}): initCount=${fs.initCount}`)
    }
  }
}

await tsdb.close?.()
await rsdb.close?.()

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
