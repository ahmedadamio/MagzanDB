import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/pg_buffercache — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('pg_buffercache.tar.gz'),
  }
}

export const pg_buffercache = {
  name: 'pg-buffercache',
  setup,
}
