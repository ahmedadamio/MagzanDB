import { extensionBundleUrl } from '../src/utils.js'
// Port of pglite-extensions/pglite-pgmq — extension bundle wrapper.
const setup = async (_pg, emscriptenOpts) => ({
  emscriptenOpts,
  bundlePath: extensionBundleUrl('pgmq.tar.gz'),
})

export const pgmq = { name: 'pgmq', setup }
