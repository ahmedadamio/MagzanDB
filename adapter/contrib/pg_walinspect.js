import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/pg_walinspect — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('pg_walinspect.tar.gz'),
  }
}

export const pg_walinspect = {
  name: 'pg-walinspect',
  setup,
}
