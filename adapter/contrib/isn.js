import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/isn — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('isn.tar.gz'),
  }
}

export const isn = {
  name: 'isn',
  setup,
}
