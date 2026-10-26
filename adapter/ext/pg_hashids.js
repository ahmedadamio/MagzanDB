import { extensionBundleUrl } from '../src/utils.js'
// Port of pglite-extensions/pglite-pg_hashids — extension bundle wrapper.
const setup = async (_pg, emscriptenOpts) => ({
  emscriptenOpts,
  bundlePath: extensionBundleUrl('pg_hashids.tar.gz'),
})

export const pg_hashids = { name: 'pg_hashids', setup }
