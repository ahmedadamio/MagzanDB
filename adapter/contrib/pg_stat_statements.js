import { extensionBundleUrl } from '../src/utils.js'
// Generated port of contrib/pg_stat_statements — extension bundle descriptor.
const setup = async (_pg, _emscriptenOpts) => {
  return {
    bundlePath: extensionBundleUrl('pg_stat_statements.tar.gz'),
  }
}

export const pg_stat_statements = {
  name: 'pg-stat-statements',
  setup,
}
