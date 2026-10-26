import { extensionBundleUrl } from '../src/utils.js'
// Port of pglite-extensions/pglite-pg_ivm — extension bundle wrapper.
const setup = async (_pg, emscriptenOpts) => ({
  emscriptenOpts,
  bundlePath: extensionBundleUrl('pg_ivm.tar.gz'),
})

export const pg_ivm = { name: 'pg_ivm', setup }
