import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/file_fdw — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('file_fdw.tar.gz'),
  }
}

export const file_fdw = {
  name: 'file-fdw',
  setup,
}
