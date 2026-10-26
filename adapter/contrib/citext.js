import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/citext — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('citext.tar.gz'),
  }
}

export const citext = {
  name: 'citext',
  setup,
}
