import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/dict_xsyn — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('dict_xsyn.tar.gz'),
  }
}

export const dict_xsyn = {
  name: 'dict-xsyn',
  setup,
}
