import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/tsm_system_rows — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('tsm_system_rows.tar.gz'),
  }
}

export const tsm_system_rows = {
  name: 'tsm-system-rows',
  setup,
}
