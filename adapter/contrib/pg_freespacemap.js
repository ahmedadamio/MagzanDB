import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/pg_freespacemap — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('pg_freespacemap.tar.gz'),
  }
}

export const pg_freespacemap = {
  name: 'pg-freespacemap',
  setup,
}
