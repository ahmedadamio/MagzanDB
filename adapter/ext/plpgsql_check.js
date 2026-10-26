import { extensionBundleUrl } from '../src/utils.js'
// Port of pglite-extensions/pglite-plpgsql_check — extension bundle wrapper.
// NOTE: tarball is produced by the postgres-pglite wasm build (not published);
// place plpgsql_check.tar.gz in release/ to use.
const setup = async (_pg, emscriptenOpts) => ({
  emscriptenOpts,
  bundlePath: extensionBundleUrl('plpgsql_check.tar.gz'),
})

export const plpgsql_check = { name: 'plpgsql_check', setup }
