import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/bloom — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('bloom.tar.gz'),
  }
}

export const bloom = {
  name: 'bloom',
  setup,
}
