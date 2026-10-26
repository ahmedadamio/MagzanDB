// pg_dump tool — vendored Emscripten pg_dump module (same wasm build as the
// reference pglite-tools package) driving the live PGlite instance through
// execProtocolRawStream + PROXYFS-mounted datadir.
//
// The vendored chunk exports {a: PG_ROOT, b: pgDump} — identical interface to
// @electric-sql/pglite-tools: pgDump({pg, args?, fileName?}) → File.
export { a as PG_ROOT, b as pgDump } from '../vendor-tools/pgdump-chunk.js'
