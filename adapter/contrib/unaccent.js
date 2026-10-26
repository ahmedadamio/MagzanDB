import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/unaccent — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('unaccent.tar.gz'),
  }
}

export const unaccent = {
  name: 'unaccent',
  setup,
}
