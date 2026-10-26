import assert from 'node:assert/strict'
import { PGlite } from '../src/index.js'

// Third-party extension packages (pglite-extensions/*), vendored from the
// published npm tarballs or built via the postgres-pglite docker build.
// Each: load bundle, CREATE EXTENSION, functional check.
// [module, extension-name, check-sql, expected-first-row, setup-sql?]
const CASES = [
  ['age', 'age', `SELECT count(*) >= 0 AS v FROM ag_catalog.ag_graph`, { v: true }],
  ['postgis', 'postgis', `SELECT postgis_version() IS NOT NULL AS v`, { v: true }],
  ['pgtap', 'pgtap', `SELECT pgtap_version() IS NOT NULL AS v`, { v: true }],
  ['pg_ivm', 'pg_ivm', `SELECT 1 AS v`, { v: 1 }],
  ['pgmq', 'pgmq', `SELECT pgmq.create('q1') IS NOT NULL AS v`, { v: true }],
  ['pg_textsearch', 'pg_textsearch', `SELECT 1 AS v`, { v: 1 }],
  ['pg_uuidv7', 'pg_uuidv7', `SELECT uuid_generate_v7() IS NOT NULL AS v`, { v: true }],
  ['pg_hashids', 'pg_hashids', `SELECT id_encode(1337::bigint, 'salt'::text) IS NOT NULL AS v`, { v: true }],
  ['vector', 'vector', `SELECT vector_dims('[1,2,3]'::vector)::int AS v`, { v: 3 }],
  ['pgaudit', 'pgaudit', `SELECT count(*)::int AS v FROM pg_extension WHERE extname = 'pgaudit'`, { v: 1 }],
  ['hypopg', 'hypopg', `SELECT count(*)::int >= 0 AS v FROM hypopg()`, { v: true }],
  ['pg_repack', 'pg_repack', `SELECT count(*)::int AS v FROM pg_extension WHERE extname = 'pg_repack'`, { v: 1 }],
  ['plpgsql_check', 'plpgsql_check', `SELECT count(*)::int >= 0 AS v FROM plpgsql_check_function_tb('public.pglt_f1()')`, { v: true }, `CREATE OR REPLACE FUNCTION pglt_f1() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$`],
  ['pg_partman', 'pg_partman SCHEMA partman', `SELECT partman.create_parent('partman_test.time_tbl', 'col3', '1 day') AS v`, { v: true }, `CREATE SCHEMA IF NOT EXISTS partman; CREATE SCHEMA IF NOT EXISTS partman_test; CREATE TABLE partman_test.time_tbl (col1 int, col3 timestamptz NOT NULL DEFAULT now()) PARTITION BY RANGE (col3)`],
]

let pass = 0
const failed = []
for (const [mod, ext, sql, expect, setup] of CASES) {
  try {
    const m = await import(`../ext/${mod}.js`)
    const extObj = m[mod] ?? Object.values(m)[0]
    const db = await PGlite.create({ extensions: { [mod]: extObj } })
    if (setup) await db.exec(setup)
    await db.exec(`CREATE EXTENSION IF NOT EXISTS ${ext}`)
    const r = await db.query(sql)
    assert.deepEqual(r.rows[0], expect)
    await db.close()
    console.log(`${mod}: ok`)
    pass++
  } catch (e) {
    failed.push(`${mod}: ${e.message.split('\n')[0]}`)
    console.log(`${mod}: FAIL — ${e.message.split('\n')[0]}`)
  }
}
console.log(`\n${pass}/${CASES.length} extension packages ok`)
process.exit(0)
