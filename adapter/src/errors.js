// Error rehydration — DatabaseError/NoticeMessage class identity stays in JS
// (reference: pg-protocol/messages.ts), fields arrive as JSON descriptors.
import { decode } from './values.js'

export class DatabaseError extends Error {
  severity
  code
  detail
  hint
  position
  internalPosition
  internalQuery
  where
  schema
  table
  column
  dataType
  constraint
  file
  line
  routine
  constructor(message, length, name) {
    super(message)
    this.length = length
    this.name = name
  }
}

export class NoticeMessage {
  severity
  code
  detail
  hint
  position
  internalPosition
  internalQuery
  where
  schema
  table
  column
  dataType
  constraint
  file
  line
  routine
  constructor(length, name = 'notice') {
    this.length = length
    this.name = name
  }
}

const NOTICE_FIELDS = [
  'severity', 'code', 'detail', 'hint', 'position', 'internalPosition',
  'internalQuery', 'where', 'schema', 'table', 'column', 'dataType',
  'constraint', 'file', 'line', 'routine',
]

function fillFields(target, fields) {
  if (!fields) return target
  for (const k of NOTICE_FIELDS) {
    if (fields[k] !== undefined && fields[k] !== null) target[k] = fields[k]
  }
  return target
}

export function noticeFromJson(fields) {
  const n = new NoticeMessage(fields?.length ?? 0, 'notice')
  n.message = fields?.message
  return fillFields(n, fields)
}

export function databaseErrorFromJson(fields) {
  const e = new DatabaseError(fields?.message ?? '', fields?.length ?? 0, 'error')
  return fillFields(e, fields)
}

/**
 * Convert a thrown `{__pglite: ...}` bridge object into a JS error.
 * Returns undefined when `e` isn't a bridge error.
 */
export function rehydrateBridgeError(e) {
  if (!e || typeof e !== 'object' || typeof e.__pglite !== 'string') {
    return undefined
  }
  switch (e.__pglite) {
    case 'pgliteError': {
      const err = databaseErrorFromJson(e.fields)
      err.query = e.query
      err.params = Array.isArray(e.params) ? e.params.map(decode) : undefined
      // queryOptions carries callbacks — presence only.
      return err
    }
    case 'databaseError':
      return databaseErrorFromJson(e.fields)
    case 'codec':
      return new TypeError(e.message ?? 'pglite codec error')
    case 'transport':
    case 'parse':
    default:
      return new Error(e.message ?? 'pglite error')
  }
}

/** Rethrow bridge errors as proper JS error instances, else rethrow as-is. */
export function rethrow(e) {
  throw rehydrateBridgeError(e) ?? e
}
