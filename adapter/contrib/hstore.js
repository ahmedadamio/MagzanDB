import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/hstore — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('hstore.tar.gz'),
  }
}

export const hstore = {
  name: 'hstore',
  setup,
}
