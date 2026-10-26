import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/tsm_system_time — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('tsm_system_time.tar.gz'),
  }
}

export const tsm_system_time = {
  name: 'tsm-system-time',
  setup,
}
