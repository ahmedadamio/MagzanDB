import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/pg_trgm — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('pg_trgm.tar.gz'),
  }
}

export const pg_trgm = {
  name: 'pg-trgm',
  setup,
}
