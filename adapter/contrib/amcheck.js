import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/amcheck — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('amcheck.tar.gz'),
  }
}

export const amcheck = {
  name: 'amcheck',
  setup,
}
