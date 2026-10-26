import { extensionBundleUrl } from '../src/utils.js'
// Port of pglite-extensions/pglite-hypopg — needs shared_preload_libraries.
// NOTE: tarball is produced by the postgres-pglite wasm build (not published);
// place hypopg.tar.gz in release/ to use.
const setup = async (_pg, emscriptenOpts) => ({
  emscriptenOpts,
  bundlePath: extensionBundleUrl('hypopg.tar.gz'),
  sharedPreloadLibraries: ['hypopg'],
})

export const hypopg = { name: 'hypopg', setup }
