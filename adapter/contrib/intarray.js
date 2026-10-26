import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/intarray — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('intarray.tar.gz'),
  }
}

export const intarray = {
  name: 'intarray',
  setup,
}
