import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { PGlite } from '../src/index.js'

// Per-extension smoke checks. `ext` = CREATE EXTENSION name (null = preload
// only, bundle load itself is the check). `needs` = prerequisite extensions.
// `setup` runs via exec (multi-statement ok); `sql` runs via query and its
// first row is deepEqual'd against `expect` when given.
const CHECKS = {
  amcheck: { ext: 'amcheck', sql: `SELECT bt_index_check(oid) FROM pg_class WHERE relkind = 'i' LIMIT 1` },
  auto_explain: { ext: null },
  bloom: { ext: 'bloom', setup: `CREATE TABLE bt (i int); CREATE INDEX bi ON bt USING bloom(i)`, sql: `SELECT 1 AS v`, expect: { v: 1 } },
  btree_gin: { ext: 'btree_gin', setup: `CREATE TABLE tg (t text); CREATE INDEX tgi ON tg USING gin(t)`, sql: `SELECT 1 AS v`, expect: { v: 1 } },
  btree_gist: { ext: 'btree_gist', setup: `CREATE TABLE bgt (i int); CREATE INDEX bgti ON bgt USING gist(i)`, sql: `SELECT 1 AS v`, expect: { v: 1 } },
  citext: { ext: 'citext', sql: `SELECT 'AbC'::citext = 'abc'::citext AS eq`, expect: { eq: true } },
  cube: { ext: 'cube', sql: `SELECT '(1,2)'::cube <-> '(1,3)'::cube AS d`, expect: { d: 1 } },
  dict_int: { ext: 'dict_int', sql: `SELECT 1 AS v`, expect: { v: 1 } },
  dict_xsyn: { ext: 'dict_xsyn', sql: `SELECT 1 AS v`, expect: { v: 1 } },
  earthdistance: { ext: 'earthdistance', needs: ['cube'], sql: `SELECT earth_distance(ll_to_earth(0,0), ll_to_earth(0,1)) > 0 AS d`, expect: { d: true } },
  file_fdw: { ext: 'file_fdw', setup: `CREATE SERVER s FOREIGN DATA WRAPPER file_fdw`, sql: `SELECT 1 AS v`, expect: { v: 1 } },
  fuzzystrmatch: { ext: 'fuzzystrmatch', sql: `SELECT levenshtein('kitten', 'sitting') AS d`, expect: { d: 3 } },
  hstore: { ext: 'hstore', sql: `SELECT 'a=>1'::hstore->'a' AS v`, expect: { v: '1' } },
  intarray: { ext: 'intarray', sql: `SELECT '{1,2,3}'::int[] & '{2}'::int[] AS r`, expect: { r: [2] } },
  isn: { ext: 'isn', sql: `SELECT is_valid('978-0-393-04002-9'::isbn13) AS v`, expect: { v: true } },
  lo: { ext: 'lo', sql: `SELECT 1 AS v`, expect: { v: 1 } },
  ltree: { ext: 'ltree', sql: `SELECT 'a.b.c'::ltree <@ 'a.b'::ltree AS v`, expect: { v: true } },
  moddatetime: {
    ext: 'moddatetime',
    setup: `CREATE TABLE mdt (id int, "updatedAt" timestamp);
      CREATE TRIGGER mdt_moddatetime BEFORE UPDATE ON mdt FOR EACH ROW EXECUTE PROCEDURE moddatetime("updatedAt");
      INSERT INTO mdt VALUES (1, '2000-01-01');
      UPDATE mdt SET id = 2`,
    sql: `SELECT "updatedAt" > '2000-01-01' AS v FROM mdt`,
    expect: { v: true },
  },
  pageinspect: { ext: 'pageinspect', sql: `SELECT get_raw_page('pg_class', 0) IS NOT NULL AS v`, expect: { v: true } },
  pg_buffercache: { ext: 'pg_buffercache', sql: `SELECT count(*) >= 0 AS v FROM pg_buffercache`, expect: { v: true } },
  pg_freespacemap: { ext: 'pg_freespacemap', sql: `SELECT 1 AS v`, expect: { v: 1 } },
  pg_stat_statements: { ext: 'pg_stat_statements', sql: `SELECT count(*) = 1 AS v FROM pg_extension WHERE extname = 'pg_stat_statements'`, expect: { v: true } },
  pg_surgery: { ext: 'pg_surgery', sql: `SELECT 1 AS v`, expect: { v: 1 } },
  pg_trgm: { ext: 'pg_trgm', sql: `SELECT similarity('abc', 'abd') > 0 AS v`, expect: { v: true } },
  pg_visibility: { ext: 'pg_visibility', sql: `SELECT 1 AS v`, expect: { v: 1 } },
  pg_walinspect: { ext: 'pg_walinspect', sql: `SELECT 1 AS v`, expect: { v: 1 } },
  pgcrypto: { ext: 'pgcrypto', sql: `SELECT digest('x', 'sha256') IS NOT NULL AS v`, expect: { v: true } },
  seg: { ext: 'seg', sql: `SELECT '1..2'::seg = '1..2'::seg AS v`, expect: { v: true } },
  tablefunc: { ext: 'tablefunc', sql: `SELECT count(*) = 1 AS v FROM crosstab('SELECT 1 AS r, 2 AS c, 3 AS v') AS (r int, c int, v int)`, expect: { v: true } },
  tcn: { ext: 'tcn', sql: `SELECT 1 AS v`, expect: { v: 1 } },
  tsm_system_rows: { ext: 'tsm_system_rows', sql: `SELECT 1 AS v`, expect: { v: 1 } },
  tsm_system_time: { ext: 'tsm_system_time', sql: `SELECT 1 AS v`, expect: { v: 1 } },
  unaccent: { ext: 'unaccent', sql: `SELECT unaccent('Montréal') AS v`, expect: { v: 'Montreal' } },
  uuid_ossp: { ext: 'uuid-ossp', sql: `SELECT uuid_generate_v4() IS NOT NULL AS v`, expect: { v: true } },
}

const modules = readdirSync('contrib').filter((f) => f.endsWith('.js')).sort()
let pass = 0
const failed = []
for (const mod of modules) {
  const name = mod.replace(/\.js$/, '')
  const check = CHECKS[name]
  if (!check) { failed.push(`${name}: no check defined`); continue }
  try {
    const exts = { [name]: Object.values(await import(`../contrib/${mod}`))[0] }
    for (const n of check.needs ?? []) {
      exts[n] = Object.values(await import(`../contrib/${n}.js`))[0]
    }
    const db = await PGlite.create({ extensions: exts })
    for (const n of check.needs ?? []) {
      await db.exec(`CREATE EXTENSION IF NOT EXISTS "${n}"`)
    }
    if (check.ext) await db.exec(`CREATE EXTENSION IF NOT EXISTS "${check.ext}"`)
    if (check.setup) await db.exec(check.setup)
    if (check.sql) {
      const r = await db.query(check.sql)
      if (check.expect) assert.deepEqual(r.rows[0], check.expect)
    }
    await db.close()
    console.log(`${name}: ok`)
    pass++
  } catch (e) {
    failed.push(`${name}: ${e.message.split('\n')[0]}`)
    console.log(`${name}: FAIL — ${e.message.split('\n')[0]}`)
  }
}
console.log(`\n${pass}/${modules.length} extensions ok`)
if (failed.length) console.log('failed:', failed.join(' | '))
process.exit(0)
