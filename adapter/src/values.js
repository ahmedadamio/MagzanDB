// Tagged-JSON value bridge — JS half of pglite_core::value::tag.
//
// JSON cannot represent bigint/undefined/Date/Uint8Array/NaN/±Infinity or
// objects with duplicate keys. Every value crossing the bridge is encoded as
// a JSON structure with $-prefixed tags for the non-JSON cases.

export function encode(v) {
  if (v === undefined) return { $undefined: true }
  if (v === null) return null
  if (typeof v === 'bigint') return { $bigint: v.toString() }
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { $num: 'NaN' }
    if (v === Infinity) return { $num: 'Infinity' }
    if (v === -Infinity) return { $num: '-Infinity' }
    return v
  }
  if (typeof v === 'boolean' || typeof v === 'string') return v
  if (v instanceof Date) return { $datems: v.getTime() }
  if (v instanceof Uint8Array) return { $bytes: toHex(v) }
  if (v instanceof ArrayBuffer) return { $bytes: toHex(new Uint8Array(v)) }
  if (ArrayBuffer.isView(v)) {
    return { $bytes: toHex(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) }
  }
  if (Array.isArray(v)) return v.map(encode)
  if (typeof v === 'object') {
    // Preserve insertion order; duplicate keys can't exist in a decoded JS
    // object anyway (they only exist on the Rust side from PG rows).
    const pairs = []
    for (const k of Object.keys(v)) {
      pairs.push({ $k: k, $v: encode(v[k]) })
    }
    return { $objpairs: pairs }
  }
  return null
}

export function decode(j) {
  if (j === null || j === undefined) return null
  if (Array.isArray(j)) return j.map(decode)
  if (typeof j === 'object') {
    if (j.$undefined === true) return undefined
    if (typeof j.$bigint === 'string') return BigInt(j.$bigint)
    if (typeof j.$bytes === 'string') return fromHex(j.$bytes)
    if (typeof j.$datestr === 'string') return new Date(j.$datestr)
    if (typeof j.$datems === 'number') return new Date(j.$datems)
    if (typeof j.$num === 'string') {
      if (j.$num === 'NaN') return NaN
      if (j.$num === 'Infinity') return Infinity
      if (j.$num === '-Infinity') return -Infinity
      return NaN
    }
    if (Array.isArray(j.$objpairs)) {
      const obj = {}
      for (const it of j.$objpairs) obj[it.$k] = decode(it.$v)
      return obj
    }
    // Plain decoded object (preserve order)
    const obj = {}
    for (const k of Object.keys(j)) obj[k] = decode(j[k])
    return obj
  }
  return j
}

export function encodeAll(values) {
  return JSON.stringify(values.map(encode))
}

export function decodeRows(rows) {
  return rows.map((row) => row.map(decode))
}

function toHex(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0')
  return s
}

function fromHex(s) {
  const out = new Uint8Array(s.length >> 1)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.substr(i * 2, 2), 16) || 0
  }
  return out
}
