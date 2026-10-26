import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/pgcrypto — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('pgcrypto.tar.gz'),
  }
}

export const pgcrypto = {
  name: 'pgcrypto',
  setup,
}
