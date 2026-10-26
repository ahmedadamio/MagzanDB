// Electric sync provider — adapts MultiShapeStream
// (@electric-sql/experimental) + the @electric-sql/client message predicates
// to the SyncProvider contract consumed by src/sync.js.
//
// The external deps are imported lazily inside init()/createStream so this
// module loads fine without them installed; they are only required when an
// Electric-backed sync is actually started.
let clientDepsPromise = null
function clientDeps() {
  clientDepsPromise ??= Promise.all([
    import('@electric-sql/client'),
    import('@electric-sql/experimental'),
  ]).then(([client, experimental]) => ({
    isChangeMessage: client.isChangeMessage,
    isControlMessage: client.isControlMessage,
    MultiShapeStream: experimental.MultiShapeStream,
  }))
  return clientDepsPromise
}

export function electric() {
  let isChangeMessage = () => {
    throw new Error('electric provider used before init()')
  }
  let isControlMessage = isChangeMessage

  return {
    name: 'electric',
    // Optional one-time hook run before any messages are classified.
    async init() {
      const deps = await clientDeps()
      isChangeMessage = deps.isChangeMessage
      isControlMessage = deps.isControlMessage
    },
    isChangeMessage: (message) => isChangeMessage(message),
    isControlMessage: (message) => isControlMessage(message),
    async createStream({ shapes }) {
      const { MultiShapeStream } = await clientDeps()
      const multiShapeStream = new MultiShapeStream({ shapes })
      return {
        subscribe: (...args) => multiShapeStream.subscribe(...args),
        unsubscribeAll: () => multiShapeStream.unsubscribeAll(),
        get isUpToDate() {
          return multiShapeStream.isUpToDate
        },
        getShapeState: (name) => ({
          handle: multiShapeStream.shapes[name].shapeHandle,
          offset: multiShapeStream.shapes[name].lastOffset,
        }),
        getStream: (name) => multiShapeStream.shapes[name],
      }
    },
  }
}
