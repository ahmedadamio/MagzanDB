import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/pageinspect — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('pageinspect.tar.gz'),
  }
}

export const pageinspect = {
  name: 'pageinspect',
  setup,
}
