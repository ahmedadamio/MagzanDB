import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/lo — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('lo.tar.gz'),
  }
}

export const lo = {
  name: 'lo',
  setup,
}
