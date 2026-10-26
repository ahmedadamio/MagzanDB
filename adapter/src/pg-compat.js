// Port of packages/pglite-node-postgres — node-postgres (pg) connection
// adapter over PGlite's execProtocolStream. Wire serialization reuses
// @electric-sql/pg-protocol (identical byte format).
import { EventEmitter } from 'events'
import { serialize } from './vendor/pg-protocol/index.js'

export class PGlitePgConfig {
  constructor(config) {
    this.connection = new Connection({ pglite: config.pglite })
  }

  connection
  poolSize = 1 // PGlite is single connection at the moment
  password = 'dummy' // PGlite accepts any password
  user = 'postgres' // dummy
  database = 'postgres' // dummy
  port = 5432 // dummy
  host = 'localhost' // dummy
}

export class Connection extends EventEmitter {
  #pglite
  #emitMessage = false
  #queue = Promise.resolve()

  // checked by pg's Client.end(), which skips connection.end() without it
  _connecting = false

  // pg's Client.end() destroys the stream when a query is still active
  stream = { destroy: () => this.end() }

  #send(buffer) {
    this.#queue = this.#queue
      .then(() =>
        this.#pglite.execProtocolStream(buffer, { throwOnError: false }),
      )
      .then((messages) => {
        messages.forEach((m) => {
          if (this.#emitMessage) {
            this.emit('message', m)
          }
          // node-postgres expects ErrorResponse as 'errorMessage'
          this.emit(m.name === 'error' ? 'errorMessage' : m.name, m)
        })
      })
      .catch((err) => {
        this.emit('error', err)
      })
  }

  parsedStatements = {}
  submittedNamedStatements = {}

  constructor(config) {
    super()
    this.#pglite = config.pglite

    this.on('newListener', (eventName) => {
      if (eventName === 'message') {
        this.#emitMessage = true
      }
    })
  }

  connect(_port, _host) {
    this._connecting = true
    process.nextTick(() => this.emit('readyForQuery'))
  }

  requestSsl() {
    // dummy
  }

  startup(_config) {
    // dummy
  }

  cancel(_processID, _secretKey) {
    // dummy
  }

  password(_password) {
    // dummy
  }

  sendSASLInitialResponseMessage(mechanism, initialResponse) {
    this.#send(
      serialize.sendSASLInitialResponseMessage(mechanism, initialResponse),
    )
  }

  sendSCRAMClientFinalMessage(additionalData) {
    this.#send(serialize.sendSCRAMClientFinalMessage(additionalData))
  }

  query(text) {
    this.#send(serialize.query(text))
  }

  parse(query) {
    this.#send(serialize.parse(query))
  }

  bind(config) {
    this.#send(serialize.bind(config))
  }

  execute(config) {
    this.#send(serialize.execute(config))
  }

  flush() {
    this.#send(serialize.flush())
  }

  sync() {
    this.#send(serialize.sync())
  }

  end() {
    // like a socket closing: pg waits for 'end'. The PGlite instance is
    // shared and owned by the caller, so it stays open.
    this.#queue = this.#queue.then(() => {
      this.emit('end')
    })
    // the pool reuses this connection for its next client: drop the
    // ended client's listeners so they don't receive its messages
    this.eventNames()
      .filter((e) => e !== 'newListener')
      .forEach((e) => this.removeAllListeners(e))
    this.#emitMessage = false
  }

  close(msg) {
    this.#send(serialize.close(msg))
  }

  describe(msg) {
    this.#send(serialize.describe(msg))
  }

  sendCopyFromChunk(chunk) {
    this.#send(serialize.copyData(chunk))
  }

  endCopyFrom() {
    this.#send(serialize.copyDone())
  }

  sendCopyFail(msg) {
    this.#send(serialize.copyFail(msg))
  }

  ref() {
    // dummy
  }

  unref() {
    // dummy
  }
}
