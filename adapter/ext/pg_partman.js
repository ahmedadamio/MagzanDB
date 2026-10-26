import { extensionBundleUrl } from '../src/utils.js'
// Port of pglite-extensions/pglite-pg_partman — extension bundle wrapper.
// NOTE: tarball is produced by the postgres-pglite wasm build (not published);
// place pg_partman.tar.gz in release/ to use.
const setup = async (_pg, emscriptenOpts) => ({
  emscriptenOpts,
  bundlePath: extensionBundleUrl('pg_partman.tar.gz'),
})

export const pg_partman = { name: 'pg_partman', setup }
