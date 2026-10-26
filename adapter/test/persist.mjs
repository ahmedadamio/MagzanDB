// Persistence check: NodeFS dataDir survives close/reopen — across real
// process restarts (phase 1 writes + closes, phase 2 reopens in a new node
// process), plus same-process reopen for good measure.
import { PGlite } from '../src/index.js'
import { execFileSync } from 'node:child_process'
import * as fs from 'fs'

const dir = '/tmp/pglite-rust-persist-test'
const phase = process.argv[2]

if (phase === 'write') {
  const pg = await PGlite.create(dir)
  await pg.exec('CREATE TABLE persist_test(v int); INSERT INTO persist_test VALUES (42)')
  await pg.close()
  process.exit(0)
}
if (phase === 'read') {
  const pg = await PGlite.create(dir)
  const r = await pg.query('SELECT v FROM persist_test')
  await pg.close()
  if (r.rows[0].v !== 42) {
    console.error('FAIL: expected 42, got', JSON.stringify(r.rows))
    process.exit(1)
  }
  process.exit(0)
}

// orchestrator
fs.rmSync(dir, { recursive: true, force: true })
execFileSync(process.execPath, [new URL(import.meta.url).pathname, 'write'], { stdio: 'inherit' })
console.log('phase 1: wrote + closed in process A')
execFileSync(process.execPath, [new URL(import.meta.url).pathname, 'read'], { stdio: 'inherit' })
console.log('phase 2: reopened + read in process B — persisted')

// same-process reopen too
const pg = await PGlite.create(dir)
const r = await pg.query('SELECT v FROM persist_test')
await pg.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log(r.rows[0].v === 42 ? 'PASS persisted' : 'FAIL persisted')
process.exit(r.rows[0].v === 42 ? 0 : 1)
