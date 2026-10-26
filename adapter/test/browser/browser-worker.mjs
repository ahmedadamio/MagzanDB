// Web Worker host for browser testing.
const dbg = new BroadcastChannel('pgl-debug')
dbg.postMessage('worker: module loaded')
try {
  const { worker } = await import('/src/worker.js')
  const { PGlite } = await import('/src/index.js')
  dbg.postMessage('worker: imports ok')

  await worker({
    init: async (options) => {
      dbg.postMessage('worker: init ' + JSON.stringify(options))
      const db = await PGlite.create(options)
      dbg.postMessage('worker: created')
      return db
    },
  })
  dbg.postMessage('worker: worker() done')
} catch (e) {
  dbg.postMessage('worker: ERROR ' + (e.stack || e))
  throw e
}
