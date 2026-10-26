// Verifies the pluggable sync provider contract end-to-end: an in-memory
// provider drives the full commit pipeline (LSN buffering, transactions,
// must-refetch truncate, subscription-state resume) — no Electric server.
import assert from 'node:assert/strict'
import { PGlite } from '../src/index.js'
import { sync } from '../src/sync.js'

let pass = 0
const ok = (name, cond, extra = '') => {
  pass += cond ? 1 : 0
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`)
  if (!cond) process.exitCode = 1
}

// In-memory provider: emits messages in the normalized envelope
// ({shape, headers:{operation,lsn,last,control,...}, key, value}).
function memoryProvider() {
  const streams = []
  return {
    name: 'memory',
    isChangeMessage: (m) => m.headers?.operation !== undefined,
    isControlMessage: (m) => m.headers?.control !== undefined,
    async createStream({ shapes }) {
      const subs = []
      let upToDate = false
      const self = {
        shapeNames: Object.keys(shapes),
        emitted: [],
        subscribe: (cb, onErr) => {
          subs.push(cb)
          return () => {}
        },
        unsubscribeAll: () => (subs.length = 0),
        get isUpToDate() {
          return upToDate
        },
        setUpToDate: (v) => (upToDate = v),
        getShapeState: (name) => ({ handle: `h-${name}`, offset: 0 }),
        getStream: (name) => self,
        // test hook: deliver messages stamped with a shape name
        emit: (shapeName, messages) => {
          self.emitted.push(...messages)
          for (const cb of subs) {
            cb(messages.map((m) => ({ ...m, shape: shapeName })))
          }
        },
      }
      streams.push(self)
      return self
    },
    get streams() {
      return streams
    },
  }
}

const provider = memoryProvider()
const db = await PGlite.create('memory://', {
  extensions: { sync: sync({ provider }) },
})
await db.exec(`CREATE TABLE items (id text primary key, v int)`)

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms))
const rows = async () =>
  (await db.query('SELECT id, v FROM items ORDER BY id')).rows

// --- insert commit -------------------------------------------------------
const sub = await db.sync.syncShapeToTable({
  shape: { fake: 'descriptor' },
  table: 'items',
  primaryKey: ['id'],
})
const stream = provider.streams[0]

stream.emit('shape', [
  {
    headers: { operation: 'insert', lsn: '1' },
    key: 'a',
    value: { id: 'a', v: 1 },
  },
  {
    headers: { operation: 'insert', lsn: '1', last: true },
    key: 'b',
    value: { id: 'b', v: 2 },
  },
])
await wait(150)
ok('provider: inserts committed', (await rows()).length === 2, JSON.stringify(await rows()))

// --- update + delete ------------------------------------------------------
stream.emit('shape', [
  {
    headers: { operation: 'update', lsn: '2' },
    key: 'a',
    value: { id: 'a', v: 10 },
  },
  {
    headers: { operation: 'delete', lsn: '2', last: true },
    key: 'b',
    value: { id: 'b', v: 2 },
  },
])
await wait(150)
ok(
  'provider: update+delete committed',
  JSON.stringify(await rows()) === JSON.stringify([{ id: 'a', v: 10 }]),
  JSON.stringify(await rows()),
)

// --- must-refetch truncates then re-syncs ---------------------------------
stream.emit('shape', [
  { headers: { control: 'must-refetch' } },
  {
    headers: { operation: 'insert', lsn: '3', last: true },
    key: 'z',
    value: { id: 'z', v: 99 },
  },
])
await wait(200)
ok(
  'provider: must-refetch truncates + resyncs',
  JSON.stringify(await rows()) === JSON.stringify([{ id: 'z', v: 99 }]),
  JSON.stringify(await rows()),
)

// --- onInitialSync via isUpToDate -----------------------------------------
let initialSyncFired = false
await db.sync.syncShapeToTable({
  shape: { fake: 'two' },
  table: 'items2',
  primaryKey: ['id'],
  onInitialSync: () => (initialSyncFired = true),
})
await db.exec(`CREATE TABLE items2 (id text primary key, v int)`)
provider.streams[1].emit('shape', [
  {
    headers: { operation: 'insert', lsn: '1', last: true },
    key: 'x',
    value: { id: 'x', v: 5 },
  },
])
provider.streams[1].setUpToDate(true)
provider.streams[1].emit('shape', [
  { headers: { control: 'up-to-date', global_last_seen_lsn: '1' } },
])
await wait(150)
ok('provider: onInitialSync fired on up-to-date', initialSyncFired === true)

// --- subscription state resume ----------------------------------------------
const db2 = await PGlite.create('memory://', {
  extensions: { sync: sync({ provider }) },
})
await db2.exec(`CREATE TABLE t3 (id text primary key, v int)`)
await db2.sync.syncShapesToTables({
  key: 'sub-1',
  shapes: {
    s3: { shape: { fake: 'three' }, table: 't3', primaryKey: ['id'] },
  },
})
provider.streams[2].emit('s3', [
  {
    headers: { operation: 'insert', lsn: '7', last: true },
    key: 'k',
    value: { id: 'k', v: 7 },
  },
])
await wait(150)
const st = await db2.query(
  `SELECT key, last_lsn FROM electric.subscriptions_metadata WHERE key = 'sub-1'`,
)
ok(
  'provider: subscription state persisted',
  st.rows.length === 1 && String(st.rows[0].last_lsn) === '7',
  JSON.stringify(st.rows),
)

// --- unsubscribe stops delivery ---------------------------------------------
await sub.unsubscribe()
const before = (await rows()).length
stream.emit('shape', [
  {
    headers: { operation: 'insert', lsn: '9', last: true },
    key: 'n',
    value: { id: 'n', v: 0 },
  },
])
await wait(150)
ok('provider: unsubscribe stops commits', (await rows()).length === before)

console.log(`\n${pass} provider checks passed`)
await db.close()
await db2.close()
process.exit(process.exitCode || 0)
