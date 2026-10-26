import assert from 'node:assert/strict'
import { PGlite } from '../src/index.js'
import {
  applyMessageToTable,
  applyInsertsToTable,
  applyMessagesToTableWithJson,
  applyMessagesToTableWithCopy,
} from '../src/sync-apply.js'
import {
  migrateSubscriptionMetadataTables,
  updateSubscriptionState,
  getSubscriptionState,
  deleteSubscriptionState,
} from '../src/sync-state.js'

const db = await PGlite.create()
await db.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT, n INT)`)

const msg = (operation, value, headers = {}) => ({
  key: 'k', value,
  headers: { operation, ...headers },
  offset: '0_0', shape: 'shape',
})

// applyMessageToTable: insert/update/delete
await applyMessageToTable({
  pg: db, table: 'items', primaryKey: ['id'], debug: false,
  message: msg('insert', { id: 'a', name: 'alpha', n: 1 }),
})
await applyMessageToTable({
  pg: db, table: 'items', primaryKey: ['id'], debug: false,
  message: msg('update', { id: 'a', name: 'beta', n: 2 }),
})
await applyMessageToTable({
  pg: db, table: 'items', primaryKey: ['id'], debug: false,
  message: msg('insert', { id: 'b', name: 'two', n: 2 }),
})
await applyMessageToTable({
  pg: db, table: 'items', primaryKey: ['id'], debug: false,
  message: msg('delete', { id: 'b', name: 'two', n: 2 }),
})
let r = await db.query('SELECT * FROM items ORDER BY id')
assert.deepEqual(r.rows, [{ id: 'a', name: 'beta', n: 2 }])
console.log('applyMessageToTable ok')

// move-in insert with ON CONFLICT DO UPDATE
await applyMessageToTable({
  pg: db, table: 'items', primaryKey: ['id'], debug: false,
  message: msg('insert', { id: 'a', name: 'moved', n: 9 }, { is_move_in: true }),
})
r = await db.query('SELECT * FROM items')
assert.equal(r.rows[0].name, 'moved')
console.log('move-in upsert ok')

// bulk inserts + mapColumns object
const inserts = []
for (let i = 0; i < 100; i++) {
  inserts.push(msg('insert', { id: `id${i}`, name: `n${i}`, n: i }))
}
await applyInsertsToTable({
  pg: db, table: 'items', primaryKey: ['id'], messages: inserts, debug: false,
})
r = await db.query('SELECT count(*) AS c FROM items')
assert.equal(r.rows[0].c, 101)
console.log('applyInsertsToTable ok')

// mapColumns mapping
await applyInsertsToTable({
  pg: db, table: 'items', primaryKey: ['id'], debug: false,
  mapColumns: { id: 'pk', name: 'label', n: 'num' },
  messages: [msg('insert', { pk: 'mapped', label: 'lbl', num: 5 })],
})
r = await db.query(`SELECT * FROM items WHERE id = 'mapped'`)
assert.deepEqual(r.rows, [{ id: 'mapped', name: 'lbl', n: 5 }])
console.log('mapColumns ok')

// json_to_recordset path
await db.exec('CREATE TABLE jitems (id INT PRIMARY KEY, v TEXT)')
await applyMessagesToTableWithJson({
  pg: db, table: 'jitems', debug: false,
  messages: [
    msg('insert', { id: 1, v: 'x' }),
    msg('insert', { id: 2, v: 'y' }),
  ],
})
r = await db.query('SELECT * FROM jitems ORDER BY id')
assert.deepEqual(r.rows, [{ id: 1, v: 'x' }, { id: 2, v: 'y' }])
console.log('applyMessagesToTableWithJson ok')

// COPY csv path
await db.exec('CREATE TABLE citems (id INT PRIMARY KEY, v TEXT)')
await applyMessagesToTableWithCopy({
  pg: db, table: 'citems', debug: false,
  messages: [
    msg('insert', { id: 1, v: 'a,b"c' }),
    msg('insert', { id: 2, v: null }),
  ],
})
r = await db.query('SELECT * FROM citems ORDER BY id')
assert.deepEqual(r.rows, [{ id: 1, v: 'a,b"c' }, { id: 2, v: null }])
console.log('applyMessagesToTableWithCopy ok')

// subscription metadata lifecycle
await migrateSubscriptionMetadataTables({ pg: db, metadataSchema: 'electric' })
await updateSubscriptionState({
  pg: db, metadataSchema: 'electric', subscriptionKey: 'sub1',
  shapeMetadata: { shape: { handle: 'h1', offset: '10_5' } },
  lastLsn: 42n,
})
const st = await getSubscriptionState({
  pg: db, metadataSchema: 'electric', subscriptionKey: 'sub1',
})
assert.equal(st.key, 'sub1')
assert.equal(st.last_lsn, 42n)
assert.deepEqual(st.shape_metadata, { shape: { handle: 'h1', offset: '10_5' } })
await updateSubscriptionState({
  pg: db, metadataSchema: 'electric', subscriptionKey: 'sub1',
  shapeMetadata: { shape: { handle: 'h2', offset: '20_0' } },
  lastLsn: 100n,
})
const st2 = await getSubscriptionState({
  pg: db, metadataSchema: 'electric', subscriptionKey: 'sub1',
})
assert.equal(st2.last_lsn, 100n)
assert.equal(st2.shape_metadata.shape.handle, 'h2')
await deleteSubscriptionState({
  pg: db, metadataSchema: 'electric', subscriptionKey: 'sub1',
})
assert.equal(await getSubscriptionState({
  pg: db, metadataSchema: 'electric', subscriptionKey: 'sub1',
}), null)
console.log('subscription state lifecycle ok')

// electricSync extension wiring (namespace + plugin shape, no server needed)
const { electricSync } = await import('../src/sync.js')
assert.equal(typeof electricSync, 'function')
const ext = electricSync({ metadataSchema: 'electric' })
assert.equal(ext.name, 'Postgres Sync')
assert.equal(typeof ext.setup, 'function')
console.log('electricSync extension shape ok')

await db.close()
console.log('sync apply/state: all passed')
