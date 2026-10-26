import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/cube — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('cube.tar.gz'),
  }
}

export const cube = {
  name: 'cube',
  setup,
}
