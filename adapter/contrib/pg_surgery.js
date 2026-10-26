import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/pg_surgery — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('pg_surgery.tar.gz'),
  }
}

export const pg_surgery = {
  name: 'pg-surgery',
  setup,
}
