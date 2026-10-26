import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/earthdistance — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('earthdistance.tar.gz'),
  }
}

export const earthdistance = {
  name: 'earthdistance',
  setup,
}
