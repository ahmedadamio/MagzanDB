// Public entry — mirrors packages/pglite/src/index.ts exports.
export { PGlite, sql, identifier, raw, queryTemplate as query } from './pglite.js'
export { DatabaseError, NoticeMessage } from './errors.js'
export {
  BaseFilesystem,
  EmscriptenBuiltinFilesystem,
  MemoryFS,
  IdbFs,
  parseDataDir,
  loadFs,
} from './fs.js'
export * as types from './types.js'
export * as parse from './parse.js'
export * as messages from './vendor/pg-protocol/messages.js'
export * as protocol from './vendor/pg-protocol/index.js'
export { Mutex } from './mutex.js'
export { formatQuery } from './utils.js'
export { PGliteWorker, worker, LeaderChangedError } from './worker.js'
