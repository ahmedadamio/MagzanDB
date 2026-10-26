import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/fuzzystrmatch — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('fuzzystrmatch.tar.gz'),
  }
}

export const fuzzystrmatch = {
  name: 'fuzzystrmatch',
  setup,
}
