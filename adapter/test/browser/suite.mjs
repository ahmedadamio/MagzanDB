// In-page test suite: real Chromium, real IndexedDB/OPFS/Web Worker.
import { PGlite, PGliteWorker } from '/src/index.js'
import { live } from '/src/live.js'

const results = []
new BroadcastChannel('pgl-debug').addEventListener('message', (e) =>
  console.log('[worker]', e.data),
)
function check(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra: String(extra) })
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`)
}

try {
  // --- memory FS smoke ---
  const db = await PGlite.create()
  check('memory: select', (await db.query('SELECT 1+1 AS sum')).rows[0].sum === 2)
  check(
    'memory: params',
    (await db.query('SELECT $1::int + $2::int AS s', [2, 3])).rows[0]
      .s === 5,
  )
  await db.exec('CREATE TABLE t (v int); INSERT INTO t VALUES (1),(2),(3)')
  check(
    'memory: exec+count',
    (await db.query('SELECT COUNT(*) c FROM t')).rows[0].c === 3,
  )
  let err
  try {
    await db.query('SELECT * FROM nope')
  } catch (e) {
    err = e
  }
  check('memory: error code', err?.code === '42P01', err?.code)
  const tx = await db.transaction(async (t) => {
    await t.query('INSERT INTO t VALUES (4)')
    return (await t.query('SELECT COUNT(*) c FROM t')).rows[0].c
  })
  check('memory: transaction', tx === 4)
  const desc = await db.describeQuery('SELECT $1::int x', { params: [7] })
  check('memory: describeQuery', desc.queryParams?.[0]?.dataTypeID === 23)
  const notify = []
  await db.listen('ch', (p) => notify.push(p))
  await db.query("SELECT pg_notify('ch','hi')")
  await new Promise((r) => setTimeout(r, 300))
  check('memory: notify', notify[0] === 'hi', JSON.stringify(notify))
  await db.close()

  // --- live query ---
  const db2 = await PGlite.create('', { extensions: { live } })
  await db2.exec('CREATE TABLE lt (id serial primary key, v int)')
  const seen = []
  const liveQ = await db2.live.query('SELECT * FROM lt', [], (res) =>
    seen.push(res.rows.length),
  )
  await new Promise((r) => setTimeout(r, 500))
  await db2.query('INSERT INTO lt (v) VALUES (10)')
  await new Promise((r) => setTimeout(r, 800))
  check('live: changes', seen.includes(1), JSON.stringify(seen))
  await liveQ.unsubscribe()
  await db2.close()

  // --- idb:// persistence (close + reopen in same page) ---
  const id1 = await PGlite.create('idb://pgl-browser-test')
  await id1.exec('CREATE TABLE p (v int); INSERT INTO p VALUES (42)')
  await id1.close()
  const id2 = await PGlite.create('idb://pgl-browser-test')
  check(
    'idbfs: persistence',
    (await id2.query('SELECT v FROM p')).rows[0].v === 42,
  )
  await id2.close()

  // --- real Web Worker + BroadcastChannel + OPFS-AHP ---
  // OPFS sync access handles only exist inside a Worker, so opfs-ahp://
  // runs through PGliteWorker exactly as upstream recommends.
  const w = new Worker('/test/browser/browser-worker.mjs', { type: 'module' })
  const wdb = await PGliteWorker.create(w, {
    dataDir: 'opfs-ahp://pgl-worker-test',
  })
  check('worker: leader', wdb.isLeader === true)
  check(
    'worker: query',
    (await wdb.query('SELECT 2*3 AS m')).rows[0].m === 6,
  )
  await wdb.exec('CREATE TABLE wt (v int); INSERT INTO wt VALUES (5)')
  const wtx = await wdb.transaction(async (t) => {
    await t.query('INSERT INTO wt VALUES (6)')
    return (await t.query('SELECT COUNT(*) c FROM wt')).rows[0].c
  })
  check('worker: transaction', wtx === 2)
  const wnotify = []
  await wdb.listen('wch', (p) => wnotify.push(p))
  await wdb.query("SELECT pg_notify('wch','yo')")
  await new Promise((r) => setTimeout(r, 400))
  check('worker: notify', wnotify[0] === 'yo', JSON.stringify(wnotify))
  await wdb.close()
  w.terminate()

  // --- opfs-ahp:// persistence across worker restarts ---
  const w2 = new Worker('/test/browser/browser-worker.mjs', { type: 'module' })
  const wdb2 = await PGliteWorker.create(w2, {
    dataDir: 'opfs-ahp://pgl-worker-test',
  })
  check(
    'opfs-ahp: persistence',
    (await wdb2.query('SELECT COUNT(*) c FROM wt')).rows[0].c === 2,
  )
  await wdb2.query('INSERT INTO wt VALUES (7)')
  await wdb2.close()
  w2.terminate()

  const w3 = new Worker('/test/browser/browser-worker.mjs', { type: 'module' })
  const wdb3 = await PGliteWorker.create(w3, {
    dataDir: 'opfs-ahp://pgl-worker-test',
  })
  check(
    'opfs-ahp: wal replay',
    (await wdb3.query('SELECT COUNT(*) c FROM wt')).rows[0].c === 3,
  )
  await wdb3.close()
  w3.terminate()
} catch (e) {
  check('suite: uncaught', false, e.stack || String(e))
}

const failed = results.filter((r) => !r.pass)
window.__RESULTS = {
  total: results.length,
  failed: failed.length,
  results,
}
window.__DONE = true
console.log(
  `BROWSER-SUITE-DONE total=${results.length} failed=${failed.length}`,
)
