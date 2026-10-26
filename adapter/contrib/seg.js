import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/seg — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('seg.tar.gz'),
  }
}

export const seg = {
  name: 'seg',
  setup,
}
