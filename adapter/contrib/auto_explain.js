import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/auto_explain — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('auto_explain.tar.gz'),
  }
}

export const auto_explain = {
  name: 'auto-explain',
  setup,
}
