// Port of worker/index.ts — PGliteWorker client (main thread side) and
// worker() host (worker thread side) speaking the same message protocol.
// The TS implementation RPCs protocol-level primitives and orchestrates
// client-side; here whole operations are RPCed because the Rust session
// transport is synchronous and cannot await a worker round-trip. Public
// behavior is preserved.

function uuid() {
  return globalThis.crypto?.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
      })
}

// Cross-environment message helpers: Web Worker / MessagePort expose
// addEventListener + postMessage; node:worker_threads uses on/postMessage.
function onMessage(target, cb) {
  if (typeof target.addEventListener === 'function') {
    target.addEventListener('message', (e) => cb(e.data))
  } else {
    target.on('message', cb)
  }
}

function postMsg(target, msg) {
  target.postMessage(msg)
}

// navigator.locks exists in browsers only; fall back to an in-process
// FIFO lock for Node (one worker per process, so a plain queue suffices).
const lockChains = new Map()
async function acquireLock(lockId) {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    let release
    await new Promise((resolve) => {
      navigator.locks.request(lockId, () => {
        return new Promise((releaseCallback) => {
          release = releaseCallback
          resolve()
        })
      })
    })
    return release
  }
  const prev = lockChains.get(lockId) ?? Promise.resolve()
  let release
  const next = new Promise((resolve) => (release = resolve))
  lockChains.set(lockId, prev.then(() => next))
  await prev
  return release
}

export class LeaderChangedError extends Error {
  constructor() {
    super('Leader changed, pending operation in indeterminate state')
  }
}

export class PGliteWorker {
  #initPromise
  #debug = 0
  #ready = false
  #closed = false
  #isLeader = false
  #eventTarget = new EventTarget()
  #tabId = uuid()
  #connected = false
  #workerProcess
  #workerID
  #broadcastChannel
  #tabChannel
  #releaseTabCloseLock
  #notifyListeners = new Map()
  #globalNotifyListeners = new Set()
  #extensions
  #extensionsClose = []

  constructor(worker, options = {}) {
    this.#workerProcess = worker
    this.#extensions = options.extensions ?? {}

    const workerHerePromise = new Promise((resolve, reject) => {
      let settled = false
      onMessage(worker, (data) => {
        if (settled) return
        settled = true
        if (data.type === 'here') resolve()
        else reject(new Error('Invalid message'))
      })
    })

    const workerReadyPromise = new Promise((resolve) => {
      onMessage(worker, (data) => {
        if (data.type === 'ready') {
          this.#workerID = data.id
          resolve()
        }
      })
    })

    this.#initPromise = (async () => {
      await workerHerePromise

      const { extensions: _e, ...workerOptions } = options
      postMsg(worker, { type: 'init', options: workerOptions })
      await workerReadyPromise

      this.#releaseTabCloseLock = await acquireLock(
        `pglite-tab-close:${this.#tabId}`,
      )

      this.#broadcastChannel = new BroadcastChannel(
        `pglite-broadcast:${this.#workerID}`,
      )
      this.#tabChannel = new BroadcastChannel(`pglite-tab:${this.#tabId}`)

      this.#broadcastChannel.addEventListener('message', (event) => {
        if (event.data.type === 'leader-here') {
          this.#connected = false
          this.#eventTarget.dispatchEvent(new Event('leader-change'))
          this.#leaderNotifyLoop()
        } else if (event.data.type === 'notify') {
          this.#receiveNotification(event.data.channel, event.data.payload)
        }
      })

      this.#tabChannel.addEventListener('message', (event) => {
        if (event.data.type === 'connected') {
          this.#connected = true
          this.#eventTarget.dispatchEvent(new Event('connected'))
          this.#ready = true
          ;(async () => {
            this.#debug = await this.#rpc('getDebugLevel')
          })()
        }
      })

      onMessage(worker, (data) => {
        if (data.type === 'leader-now') {
          this.#isLeader = true
          this.#eventTarget.dispatchEvent(new Event('leader-change'))
        }
      })

      this.#leaderNotifyLoop()

      // Wait for the worker to acknowledge this tab (avoid #initPromise
      // self-deadlock — waitReady itself is chained to #initPromise).
      await new Promise((resolve) => {
        if (this.#connected) return resolve()
        this.#eventTarget.addEventListener('connected', () => resolve(), {
          once: true,
        })
      })

      // Client-side extension setup against this interface — matches the
      // reference, which initializes extensions on the tab's PGliteWorker.
      for (const [extName, ext] of Object.entries(this.#extensions)) {
        const extRet = await ext.setup(this, {})
        if (extRet?.init) await extRet.init()
        if (extRet?.close) this.#extensionsClose.push(extRet.close)
        if (extRet?.namespaceObj) {
          this[extName] = extRet.namespaceObj
        }
      }
    })()
  }

  static async create(worker, options) {
    const pg = new PGliteWorker(worker, options)
    await pg.waitReady
    return pg
  }

  async #leaderNotifyLoop() {
    if (this.#closed) return
    if (!this.#connected) {
      this.#broadcastChannel.postMessage({ type: 'tab-here', id: this.#tabId })
      setTimeout(() => this.#leaderNotifyLoop(), 16)
    }
  }

  async #rpc(method, ...args) {
    const callId = uuid()
    this.#tabChannel.postMessage({ type: 'rpc-call', callId, method, args })
    return await new Promise((resolve, reject) => {
      const listener = (event) => {
        if (event.data.callId !== callId) return
        cleanup()
        const message = event.data
        if (message.type === 'rpc-return') {
          resolve(message.result)
        } else if (message.type === 'rpc-error') {
          const error = new Error(message.error.message)
          Object.assign(error, message.error)
          reject(error)
        } else {
          reject(new Error('Invalid message'))
        }
      }
      const leaderChangeListener = () => {
        cleanup()
        reject(new LeaderChangedError())
      }
      const cleanup = () => {
        this.#tabChannel.removeEventListener('message', listener)
        this.#eventTarget.removeEventListener(
          'leader-change',
          leaderChangeListener,
        )
      }
      this.#eventTarget.addEventListener('leader-change', leaderChangeListener)
      this.#tabChannel.addEventListener('message', listener)
    })
  }

  get waitReady() {
    return this.#initPromise.then(
      () =>
        new Promise((resolve) => {
          if (!this.#connected) {
            this.#eventTarget.addEventListener('connected', () => resolve())
          } else {
            resolve()
          }
        }),
    )
  }

  get debug() {
    return this.#debug
  }
  get ready() {
    return this.#ready
  }
  get closed() {
    return this.#closed
  }
  get isLeader() {
    return this.#isLeader
  }

  async close() {
    if (this.#closed) return
    this.#closed = true
    for (const extClose of this.#extensionsClose) await extClose()
    this.#broadcastChannel?.close()
    this.#tabChannel?.close()
    this.#releaseTabCloseLock?.()
    await this.#workerProcess.terminate()
  }

  async [Symbol.asyncDispose]() {
    await this.close()
  }

  async #runExclusiveQuery(fn) {
    await this.#rpc('_acquireQueryLock')
    try {
      return await fn()
    } finally {
      await this.#rpc('_releaseQueryLock')
    }
  }

  async query(query, params = [], options = {}) {
    return await this.#runExclusiveQuery(() =>
      this.#rpc('query', query, params, options),
    )
  }

  async sql(strings, ...params) {
    const { queryTemplate } = await import('./pglite.js')
    const { query, params: p } = queryTemplate(strings, ...params)
    return this.query(query, p)
  }

  async exec(query, options = {}) {
    return await this.#runExclusiveQuery(() => this.#rpc('exec', query, options))
  }

  async describeQuery(query, options = {}) {
    return await this.#runExclusiveQuery(() =>
      this.#rpc('describeQuery', query, options),
    )
  }

  async transaction(callback) {
    await this.#rpc('_acquireTransactionLock')
    try {
      await this.#rpc('exec', 'BEGIN')
      let closed = false
      const checkClosed = () => {
        if (closed) throw new Error('Transaction is closed')
      }
      const tx = {
        query: async (q, p = [], o) => {
          checkClosed()
          return await this.#rpc('query', q, p, o)
        },
        exec: async (q, o) => {
          checkClosed()
          return await this.#rpc('exec', q, o)
        },
        rollback: async () => {
          checkClosed()
          await this.#rpc('exec', 'ROLLBACK')
          closed = true
        },
        get closed() {
          return closed
        },
      }
      try {
        const ret = await callback(tx)
        if (!closed) {
          closed = true
          await this.#rpc('exec', 'COMMIT')
        }
        return ret
      } catch (e) {
        if (!closed) {
          closed = true
          try {
            await this.#rpc('exec', 'ROLLBACK')
          } catch {}
        }
        throw e
      }
    } finally {
      await this.#rpc('_releaseTransactionLock')
    }
  }

  async execProtocol(message, options = {}) {
    return await this.#rpc('execProtocol', message, options)
  }

  async execProtocolStream(message, options = {}) {
    return await this.#rpc('execProtocolStream', message, options)
  }

  async execProtocolRaw(message, options = {}) {
    return await this.#rpc('execProtocolRaw', message, options)
  }

  async execProtocolRawStream(message, options = {}) {
    return await this.#rpc('execProtocolRawStream', message, options)
  }

  async dumpDataDir(compression) {
    return await this.#rpc('dumpDataDir', compression)
  }

  async syncToFs() {
    return await this.#rpc('syncToFs')
  }

  async listen(channel, callback, tx) {
    const pgChannel = channel.replace(/^"|"$/g, '').toLowerCase()
    if (!this.#notifyListeners.has(pgChannel)) {
      this.#notifyListeners.set(pgChannel, new Set())
    }
    this.#notifyListeners.get(pgChannel).add(callback)
    await this.#rpc('exec', `LISTEN ${channel}`)
    return async () => {
      await this.unlisten(pgChannel, callback)
    }
  }

  async unlisten(channel, callback, tx) {
    const pgChannel = channel.replace(/^"|"$/g, '').toLowerCase()
    const listeners = this.#notifyListeners.get(pgChannel)
    if (listeners) {
      if (callback) listeners.delete(callback)
      else listeners.clear()
      if (listeners.size === 0) {
        this.#notifyListeners.delete(pgChannel)
        await this.#rpc('exec', `UNLISTEN ${channel}`)
      }
    }
  }

  onNotification(callback) {
    this.#globalNotifyListeners.add(callback)
    return () => this.#globalNotifyListeners.delete(callback)
  }

  offNotification(callback) {
    this.#globalNotifyListeners.delete(callback)
  }

  #receiveNotification(channel, payload) {
    const listeners = this.#notifyListeners.get(channel)
    if (listeners) {
      for (const listener of listeners) {
        queueMicrotask(() => listener(payload))
      }
    }
    for (const listener of this.#globalNotifyListeners) {
      queueMicrotask(() => listener(channel, payload))
    }
  }
}

// ---------------------------------------------------------------------------
// Worker-thread side. Call from a worker script:
//   import { worker } from './worker.js'
//   import { PGlite } from './index.js'
//   await worker({ init: (opts) => PGlite.create(opts) })
// ---------------------------------------------------------------------------

export async function worker({ init }) {
  const port = await workerPort()

  postMsg(port, { type: 'here' })

  const options = await new Promise((resolve) => {
    onMessage(port, (data) => {
      if (data.type === 'init') resolve(data.options)
    })
  })

  const id = options.id ?? `worker:${options.dataDir ?? ''}`

  postMsg(port, { type: 'ready', id })

  const broadcastChannel = new BroadcastChannel(`pglite-broadcast:${id}`)

  // Election: first process to take the lock becomes leader. Released on exit.
  await acquireLock(`pglite-election-lock:${id}`)

  postMsg(port, { type: 'leader-now' })
  broadcastChannel.postMessage({ type: 'leader-here', id })

  const db = await init(options)

  db.onNotification?.((channel, payload) => {
    broadcastChannel.postMessage({ type: 'notify', channel, payload })
  })

  const connectedTabs = new Set()

  broadcastChannel.addEventListener('message', (event) => {
    if (event.data.type === 'tab-here') {
      if (connectedTabs.has(event.data.id)) return
      connectedTabs.add(event.data.id)
      connectTab(event.data.id, db, broadcastChannel)
    }
  })
}

async function workerPort() {
  if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
    return self
  }
  const { parentPort } = await import('worker_threads')
  return parentPort
}

// Structured clone cannot carry functions (e.g. describeQuery's field
// `parser` placeholders); drop them while preserving cloneable values
// (Uint8Array, Date, BigInt, Blob pass through by reference semantics).
function sanitizeForClone(v, seen = new WeakMap()) {
  if (v === null || typeof v !== 'object') {
    return typeof v === 'function' || typeof v === 'symbol' ? undefined : v
  }
  if (seen.has(v)) return seen.get(v)
  if (Array.isArray(v)) {
    const out = []
    seen.set(v, out)
    for (const item of v) out.push(sanitizeForClone(item, seen))
    return out
  }
  const tag = Object.prototype.toString.call(v)
  if (
    tag !== '[object Object]' ||
    v instanceof Uint8Array ||
    v instanceof ArrayBuffer ||
    v instanceof Date ||
    (typeof Blob !== 'undefined' && v instanceof Blob) ||
    (typeof File !== 'undefined' && v instanceof File)
  ) {
    return v
  }
  const out = {}
  seen.set(v, out)
  for (const [k, val] of Object.entries(v)) {
    const s = sanitizeForClone(val, seen)
    if (s !== undefined) out[k] = s
  }
  return out
}

function makeWorkerApi(db) {
  let queryLockRelease = null
  let transactionLockRelease = null

  return {
    async getDebugLevel() {
      return db.debug
    },
    async close() {
      await db.close()
    },
    async query(query, params, options) {
      try {
        return await db._queryNoMutex(query, params, options)
      } catch (e) {
        console.error('[w-api] query failed:', query, e.code, e.message)
        throw e
      }
    },
    async exec(query, options) {
      try {
        return await db._execNoMutex(query, options)
      } catch (e) {
        console.error('[w-api] exec failed:', query, e.code, e.message)
        throw e
      }
    },
    async describeQuery(query, options) {
      return await db.describeQuery(query, options)
    },
    async execProtocol(message, options) {
      const { messages, data } = await db.execProtocol(message, options)
      if (data.byteLength !== data.buffer.byteLength) {
        const copy = new Uint8Array(new ArrayBuffer(data.byteLength))
        copy.set(data)
        return { messages, data: copy }
      }
      return { messages, data }
    },
    async execProtocolStream(message, options) {
      return await db.execProtocolStream(message, options)
    },
    async execProtocolRawStream(message, options) {
      return await db.execProtocolRawStream(message, options)
    },
    async execProtocolRaw(message, options) {
      const result = await db.execProtocolRaw(message, options)
      if (result.byteLength !== result.buffer.byteLength) {
        const copy = new Uint8Array(new ArrayBuffer(result.byteLength))
        copy.set(result)
        return copy
      }
      return result
    },
    async dumpDataDir(compression) {
      return await db.dumpDataDir(compression)
    },
    async syncToFs() {
      return await db.syncToFs()
    },
    async _handleBlob(blob) {
      return await db._handleBlob(blob)
    },
    async _getWrittenBlob() {
      return await db._getWrittenBlob()
    },
    async _cleanupBlob() {
      return await db._cleanupBlob()
    },
    async _checkReady() {
      return await db._checkReady()
    },
    async _acquireQueryLock() {
      return new Promise((resolve) => {
        db._runExclusiveQuery(() => {
          return new Promise((release) => {
            queryLockRelease = release
            resolve()
          })
        })
      })
    },
    async _releaseQueryLock() {
      queryLockRelease?.()
      queryLockRelease = null
    },
    async _acquireTransactionLock() {
      return new Promise((resolve) => {
        db._runExclusiveTransaction(() => {
          return new Promise((release) => {
            transactionLockRelease = release
            resolve()
          })
        })
      })
    },
    async _releaseTransactionLock() {
      transactionLockRelease?.()
      transactionLockRelease = null
    },
  }
}

function connectTab(tabId, db, broadcastChannel) {
  const tabChannel = new BroadcastChannel(`pglite-tab:${tabId}`)

  tabChannel.addEventListener('message', async (event) => {
    const msg = event.data
    if (msg.type === 'rpc-call') {
      await db.waitReady
      const { callId, method, args } = msg
      try {
        const result = await api[method](...args)
        tabChannel.postMessage({
          type: 'rpc-return',
          callId,
          result: sanitizeForClone(result),
        })
      } catch (error) {
        tabChannel.postMessage({
          type: 'rpc-error',
          callId,
          error: error && typeof error === 'object'
            ? { ...error, message: error.message }
            : { message: String(error) },
        })
      }
    }
  })

  const api = makeWorkerApi(db)

  tabChannel.postMessage({ type: 'connected' })
}
