import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/btree_gin — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('btree_gin.tar.gz'),
  }
}

export const btree_gin = {
  name: 'btree-gin',
  setup,
}
