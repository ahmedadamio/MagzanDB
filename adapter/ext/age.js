import { extensionBundleUrl } from '../src/utils.js'
// Port of pglite-extensions/pglite-age — extension bundle wrapper.
const setup = async (_pg, emscriptenOpts) => ({
  emscriptenOpts,
  bundlePath: extensionBundleUrl('age.tar.gz'),
})

export const age = { name: 'age', setup }
