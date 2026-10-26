import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/moddatetime — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('spi.tar.gz'),
  }
}

export const moddatetime = {
  name: 'moddatetime',
  setup,
}
