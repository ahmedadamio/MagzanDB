// Worker entry for worker_threads testing.
import { worker } from '../src/worker.js'
import { PGlite } from '../src/index.js'

console.error('[w] starting')
await worker({
  init: async (options) => {
    console.error('[w] init called')
    const db = await PGlite.create(options)
    console.error('[w] init done')
    return db
  },
})
console.error('[w] worker() returned')
