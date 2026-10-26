import { extensionBundleUrl } from '../src/utils.js'
// Port of pglite-extensions/pglite-pg_textsearch — needs shared_preload_libraries.
const setup = async (_pg, emscriptenOpts) => ({
  emscriptenOpts,
  bundlePath: extensionBundleUrl('pg_textsearch.tar.gz'),
  sharedPreloadLibraries: ['pg_textsearch'],
})

export const pg_textsearch = { name: 'pg_textsearch', setup }
