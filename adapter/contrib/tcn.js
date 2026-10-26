import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/tcn — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('tcn.tar.gz'),
  }
}

export const tcn = {
  name: 'tcn',
  setup,
}
