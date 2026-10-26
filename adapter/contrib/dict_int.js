import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/dict_int — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('dict_int.tar.gz'),
  }
}

export const dict_int = {
  name: 'dict-int',
  setup,
}
