// Port of pglite-prepopulatedfs: returns a pre-initialized data directory as
// a Blob for use with PGlite.create({ loadDataDir }), skipping initdb.
import { IN_NODE } from './utils.js'

export async function dataDir() {
  const moduleUrl = new URL('../release/prepopulatedfs.tgz', import.meta.url)
  if (IN_NODE) {
    const fs = await import('fs/promises')
    const buffer = await fs.readFile(moduleUrl)
    return new Blob([new Uint8Array(buffer)])
  } else {
    const downloadPromise = await fetch(moduleUrl)
    return downloadPromise.blob()
  }
}
