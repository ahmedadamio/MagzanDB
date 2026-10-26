// `types` namespace — mirrors packages/pglite/src/types.ts exports.
// Builtin codecs run in Rust via free bridge functions; JS-registered
// custom codecs live per-session and are not part of these tables
// (same as the reference's static `parsers`/`serializers` exports).
import {
  codec_parse_type,
  codec_serialize,
  codec_keys,
  codec_array_parse,
  codec_array_serialize,
} from '../dist/pglite_bridge.js'
import { encode, decode } from './values.js'

// `export const JSON = 114` (OID) shadows globalThis.JSON in this module —
// capture the real one first (the reference does the same via JSON_stringify).
const _JSON = globalThis.JSON

// OID constants (subset exported by the reference)
export const BOOL = 16
export const BYTEA = 17
export const CHAR = 18
export const INT8 = 20
export const INT2 = 21
export const INT4 = 23
export const REGPROC = 24
export const TEXT = 25
export const OID = 26
export const TID = 27
export const XID = 28
export const CID = 29
export const JSON = 114
export const XML = 142
export const PG_NODE_TREE = 194
export const SMGR = 210
export const PATH = 602
export const POLYGON = 604
export const CIDR = 650
export const FLOAT4 = 700
export const FLOAT8 = 701
export const ABSTIME = 702
export const RELTIME = 703
export const TINTERVAL = 704
export const CIRCLE = 718
export const MACADDR8 = 774
export const MONEY = 790
export const MACADDR = 829
export const INET = 869
export const ACLITEM = 1033
export const BPCHAR = 1042
export const VARCHAR = 1043
export const DATE = 1082
export const TIME = 1083
export const TIMESTAMP = 1114
export const TIMESTAMPTZ = 1184
export const INTERVAL = 1186
export const TIMETZ = 1266
export const BIT = 1560
export const VARBIT = 1562
export const NUMERIC = 1700
export const REFCURSOR = 1790
export const REGPROCEDURE = 2202
export const REGOPER = 2203
export const REGOPERATOR = 2204
export const REGCLASS = 2205
export const REGTYPE = 2206
export const UUID = 2950
export const TXID_SNAPSHOT = 2970
export const PG_LSN = 3220
export const JSONB = 3802
export const REGNAMESPACE = 4089
export const REGROLE = 4096

function buildTables() {
  const keys = _JSON.parse(codec_keys())
  const parsers = {}
  const serializers = {}
  for (const k of keys.parsers) {
    const key = k.oid !== undefined ? k.oid : k.name
    const oid = k.oid ?? k.to
    parsers[key] = (x, _typeId) => decode(_JSON.parse(codec_parse_type(String(x), oid)))
  }
  for (const k of keys.serializers) {
    const key = k.oid !== undefined ? k.oid : k.name
    const oid = k.oid ?? k.to
    serializers[key] = (x) => codec_serialize(oid, _JSON.stringify(encode(x)))
  }
  return { parsers, serializers }
}

let _tables = null
function tables() {
  if (!_tables) _tables = buildTables()
  return _tables
}

function lazyTable(which) {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === 'string' && !(prop in Object.prototype)) {
          return tables()[which][prop]
        }
        return undefined
      },
      has(_t, prop) {
        return prop in tables()[which]
      },
      ownKeys() {
        return Reflect.ownKeys(tables()[which])
      },
      getOwnPropertyDescriptor(_t, prop) {
        const t = tables()[which]
        if (prop in t) return { enumerable: true, configurable: true }
        return undefined
      },
    },
  )
}

export const parsers = lazyTable('parsers')
export const serializers = lazyTable('serializers')

export function parseType(x, type, parsersOverride) {
  if (x === null) return null
  const handler = parsersOverride?.[type] ?? parsers[type]
  if (handler) {
    return handler(x, type)
  }
  return x
}

export function arraySerializer(xs, serializer, typarray) {
  // Matches the reference: passthrough when xs isn't an array, otherwise
  // delegate to the Rust port (which applies arrayEscape + delimiter rules).
  if (!Array.isArray(xs)) return xs
  // The serializer arg is a JS function in the reference. For builtin element
  // codecs the adapter can't recover the oid — callers within the engine use
  // the Rust path; this export exists for API compat and falls back to
  // jsToString-style element handling when serializer is a function.
  if (typeof serializer === 'function') {
    const delimiter = typarray === 1020 ? ';' : ','
    const arrayEscape = (x) => x.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const first = xs[0]
    if (Array.isArray(first)) {
      return `{${xs.map((x) => arraySerializer(x, serializer, typarray)).join(delimiter)}}`
    }
    return `{${xs
      .map((x) => {
        if (x === undefined) x = null
        return x === null ? 'null' : '"' + arrayEscape(serializer(x)) + '"'
      })
      .join(delimiter)}}`
  }
  return codec_array_serialize(_JSON.stringify(encode(xs)), serializer ?? undefined, typarray ?? 0)
}

export function arrayParser(x, parser, typarray) {
  if (typeof parser === 'function') {
    // JS-side port of the reference loop for function parsers — used only by
    // the standalone export; engine queries go through Rust.
    return arrayParserJs(x, parser, typarray)
  }
  return decode(_JSON.parse(codec_array_parse(x, undefined, typarray ?? 0)))
}

// Reference-faithful JS port for the function-parser path.
function arrayParserJs(x, parser, typarray) {
  const s = { i: 0, char: null, str: '', quoted: false, last: 0, p: null }
  function loop() {
    const xs = []
    const delimiter = typarray === 1020 ? ';' : ','
    for (; s.i < x.length; s.i++) {
      s.char = x[s.i]
      if (s.quoted) {
        if (s.char === '\\') {
          s.str += x[++s.i]
        } else if (s.char === '"') {
          xs.push(parser(s.str))
          s.str = ''
          s.quoted = x[s.i + 1] === '"'
          s.last = s.i + 2
        } else {
          s.str += s.char
        }
      } else if (s.char === '"') {
        s.quoted = true
      } else if (s.char === '{') {
        s.last = ++s.i
        xs.push(loop())
      } else if (s.char === '}') {
        if (s.last < s.i) {
          const el = x.slice(s.last, s.i)
          if (el === 'NULL' && !s.quoted) {
            xs.push(null)
          } else {
            xs.push(parser(el))
          }
        }
        s.quoted = false
        s.last = s.i + 1
        break
      } else if (s.char === delimiter && s.p !== '}' && s.p !== '"') {
        const el = x.slice(s.last, s.i)
        if (el === 'NULL' && !s.quoted) {
          xs.push(null)
        } else {
          xs.push(parser(el))
        }
        s.last = s.i + 1
      }
      s.p = s.char
    }
    s.last < s.i && xs.push(parser(x.slice(s.last, s.i + 1)))
    return xs
  }
  s.i = s.last = 0
  return loop()[0]
}
