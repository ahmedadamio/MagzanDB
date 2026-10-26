import { extensionBundleUrl } from '../src/utils.js'
// Port of pglite-extensions/pglite-pg_uuidv7 — extension bundle wrapper.
const setup = async (_pg, emscriptenOpts) => ({
  emscriptenOpts,
  bundlePath: extensionBundleUrl('pg_uuidv7.tar.gz'),
})

export const pg_uuidv7 = { name: 'pg_uuidv7', setup }
