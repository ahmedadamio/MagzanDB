import { extensionBundleUrl } from '../src/utils.js'
// Port of pglite-extensions/pglite-vector — extension bundle wrapper.
// NOTE: tarball is produced by the postgres-pglite wasm build (not published);
// place vector.tar.gz in release/ to use.
const setup = async (_pg, emscriptenOpts) => ({
  emscriptenOpts,
  bundlePath: extensionBundleUrl('vector.tar.gz'),
})

export const vector = { name: 'vector', setup }
