// FIFO mutex with the async-mutex `Mutex` API surface
// (acquire/runExclusive/isLocked/waitForUnlock/release/cancel),
// matching what upstream re-exports from `async-mutex`.
const E_CANCELED = 'Mutex canceled'

export class Mutex {
  #waiters = [] // [{resolve, reject, fn}] oldest first
  #locked = false

  acquire(priority = 0) {
    if (!this.#locked && this.#waiters.length === 0) {
      this.#locked = true
      return Promise.resolve([undefined, () => this.release()])
    }
    return new Promise((resolve, reject) => {
      const entry = {
        priority,
        resolve: (release) => resolve([undefined, release]),
        reject,
      }
      // FIFO with priority: higher priority goes first, stable within priority
      const idx = this.#waiters.findIndex((w) => w.priority < priority)
      if (idx === -1) this.#waiters.push(entry)
      else this.#waiters.splice(idx, 0, entry)
    })
  }

  async runExclusive(fn, priority = 0) {
    const [, release] = await this.acquire(priority)
    try {
      return await fn()
    } finally {
      release()
    }
  }

  isLocked() {
    return this.#locked
  }

  waitForUnlock(priority = 0) {
    if (!this.#locked) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const entry = {
        priority,
        resolve: () => resolve(),
        reject,
        unlockOnly: true,
      }
      const idx = this.#waiters.findIndex((w) => w.priority < priority)
      if (idx === -1) this.#waiters.push(entry)
      else this.#waiters.splice(idx, 0, entry)
    })
  }

  release() {
    if (!this.#locked) return
    const next = this.#waiters.shift()
    if (!next) {
      this.#locked = false
      return
    }
    if (next.unlockOnly) {
      // a waitForUnlock waiter observed the unlock; keep mutex unlocked
      this.#locked = false
      next.resolve()
      // drain any further waitForUnlock waiters at the front
      while (this.#waiters[0]?.unlockOnly) {
        this.#waiters.shift().resolve()
      }
      // if a real acquirer is next, lock again for it
      if (this.#waiters.length) {
        this.#locked = true
        const n = this.#waiters.shift()
        n.resolve(() => this.release())
      }
    } else {
      // stays locked for the next acquirer
      next.resolve(() => this.release())
    }
  }

  cancel() {
    const waiters = this.#waiters
    this.#waiters = []
    this.#locked = false
    for (const w of waiters) w.reject(new Error(E_CANCELED))
  }
}
