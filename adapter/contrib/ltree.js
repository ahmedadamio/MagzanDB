import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/ltree — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('ltree.tar.gz'),
  }
}

export const ltree = {
  name: 'ltree',
  setup,
}
