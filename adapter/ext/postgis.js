import { WASM_PREFIX, extensionBundleUrl } from '../src/utils.js'
// Port of pglite-extensions/pglite-postgis — enables GDAL drivers + PROJ data path.

const setup = async (_pg, emscriptenOpts) => {
  emscriptenOpts.PGLITE_ENV.POSTGIS_GDAL_ENABLED_DRIVERS = 'ENABLE_ALL'
  emscriptenOpts.PGLITE_ENV.POSTGIS_ENABLE_OUTDB_RASTERS = 1
  emscriptenOpts.PGLITE_ENV.PROJ_DATA = `${WASM_PREFIX}/share/proj`

  return {
    emscriptenOpts,
    bundlePath: extensionBundleUrl('postgis.tar.gz'),
  }
}

export const postgis = { name: 'postgis', setup }
