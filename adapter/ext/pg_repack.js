import { extensionBundleUrl } from '../src/utils.js'
// Port of pglite-extensions/pglite-pg_repack — needs shared_preload_libraries.
// NOTE: tarball is produced by the postgres-pglite wasm build (not published);
// place pg_repack.tar.gz in release/ to use.
const setup = async (_pg, emscriptenOpts) => ({
  emscriptenOpts,
  bundlePath: extensionBundleUrl('pg_repack.tar.gz'),
  sharedPreloadLibraries: ['pg_repack'],
})

export const pg_repack = { name: 'pg_repack', setup }
