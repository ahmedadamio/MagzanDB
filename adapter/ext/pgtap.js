import { extensionBundleUrl } from '../src/utils.js'
// Port of pglite-extensions/pglite-pgtap — extension bundle wrapper.
const setup = async (_pg, emscriptenOpts) => ({
  emscriptenOpts,
  bundlePath: extensionBundleUrl('pgtap.tar.gz'),
})

export const pgtap = { name: 'pgtap', setup }
