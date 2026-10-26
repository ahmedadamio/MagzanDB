import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/pg_visibility — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('pg_visibility.tar.gz'),
  }
}

export const pg_visibility = {
  name: 'pg-visibility',
  setup,
}
