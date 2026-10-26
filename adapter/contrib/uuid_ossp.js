import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/uuid_ossp — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('uuid-ossp.tar.gz'),
  }
}

export const uuid_ossp = {
  name: 'uuid-ossp',
  setup,
}
