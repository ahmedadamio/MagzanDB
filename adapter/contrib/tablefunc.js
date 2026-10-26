import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/tablefunc — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('tablefunc.tar.gz'),
  }
}

export const tablefunc = {
  name: 'tablefunc',
  setup,
}
