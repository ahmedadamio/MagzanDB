import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/btree_gist — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('btree_gist.tar.gz'),
  }
}

export const btree_gist = {
  name: 'btree-gist',
  setup,
}
