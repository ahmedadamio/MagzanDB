// Port of pglite-icu-full: returns the full ICU collation data as a Blob for
// use with PGlite.create({ icuDataDir }).
import { IN_NODE } from './utils.js'

export async function icuDataDir() {
  const moduleUrl = new URL('../release/icu.76.tgz', import.meta.url)
  if (IN_NODE) {
    const fs = await import('fs/promises')
    const buffer = await fs.readFile(moduleUrl)
    return new Blob([new Uint8Array(buffer)])
  } else {
    const downloadPromise = await fetch(moduleUrl)
    return downloadPromise.blob()
  }
}
