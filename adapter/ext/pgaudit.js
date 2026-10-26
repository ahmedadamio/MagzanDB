import { extensionBundleUrl } from '../src/utils.js'
// Port of pglite-extensions/pglite-pgaudit — needs shared_preload_libraries.
// NOTE: tarball is produced by the postgres-pglite wasm build (not published);
// place pgaudit.tar.gz in release/ to use.
const setup = async (_pg, emscriptenOpts) => ({
  emscriptenOpts,
  bundlePath: extensionBundleUrl('pgaudit.tar.gz'),
  sharedPreloadLibraries: ['pgaudit'],
})

export const pgaudit = { name: 'pgaudit', setup }
