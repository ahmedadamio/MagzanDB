// Port of packages/pglite-utils/src/utils.ts — the subset the adapter needs.

export const IN_NODE =
  typeof process === 'object' &&
  typeof process.versions === 'object' &&
  typeof process.versions.node === 'string'

export const WASM_PREFIX = '/pglite'

// Extension tarballs live in <pkg>/release/. Source modules sit at
// contrib|ext/*.js (one level up); bundled dist-cjs/contrib|ext/*.cjs sit
// two levels up. Probe both depths in Node so bundlePath resolves in either
// packaging layout.
export function extensionBundleUrl(tarName) {
  if (IN_NODE) {
    // process.getBuiltinModule avoids a static node:fs import that would
    // break browser resolution of this module.
    const fs = process.getBuiltinModule?.('fs')
    for (const up of ['../release/', '../../release/']) {
      const url = new URL(`${up}${tarName}`, import.meta.url)
      try {
        if (fs?.existsSync(url)) return url
      } catch {
        continue
      }
    }
  }
  return new URL(`../release/${tarName}`, import.meta.url)
}

const artifactDownloadPromises = new Map()
const cachedWasmModules = new Map()

export async function startArtifactDownload(url) {
  if (IN_NODE || artifactDownloadPromises.has(url.toString())) return
  artifactDownloadPromises.set(url.toString(), fetch(url))
}

export async function instantiateWasm(imports, moduleUrl, module) {
  if (module || cachedWasmModules.has(moduleUrl.toString())) {
    const mod = module || cachedWasmModules.get(moduleUrl.toString())
    return { instance: await WebAssembly.instantiate(mod, imports), module: mod }
  }
  if (IN_NODE) {
    const fs = await import('fs/promises')
    const buffer = await fs.readFile(moduleUrl)
    const { module: newModule, instance } = await WebAssembly.instantiate(
      buffer,
      imports,
    )
    cachedWasmModules.set(moduleUrl.toString(), newModule)
    return { instance, module: newModule }
  } else {
    if (!artifactDownloadPromises.has(moduleUrl.toString())) {
      startArtifactDownload(moduleUrl)
    }
    const response = await artifactDownloadPromises.get(moduleUrl.toString())
    const { module: newModule, instance } =
      await WebAssembly.instantiateStreaming(response.clone(), imports)
    cachedWasmModules.set(moduleUrl.toString(), newModule)
    return { instance, module: newModule }
  }
}

export async function getFsBundle(fsBundleUrl) {
  if (IN_NODE) {
    const fs = await import('fs/promises')
    const fileData = await fs.readFile(fsBundleUrl)
    return fileData.buffer.slice(
      fileData.byteOffset,
      fileData.byteOffset + fileData.byteLength,
    )
  } else {
    startArtifactDownload(fsBundleUrl)
    const response = await artifactDownloadPromises.get(fsBundleUrl.toString())
    return response.clone().arrayBuffer()
  }
}

export function toPostgresName(input) {
  if (input.startsWith('"') && input.endsWith('"')) {
    return input.substring(1, input.length - 1)
  }
  return input.toLowerCase()
}

const TEXT_OID = 25

// Port of utils.ts formatQuery — resolves $N placeholders to literal SQL via
// Postgres' own format() %L quoting. The reference describes the statement
// with raw protocol messages; describeQuery exposes the same param OIDs.
export async function formatQuery(pg, query, params, tx) {
  if (!params || params.length === 0) {
    return query
  }
  tx = tx ?? pg
  const { queryParams } = await pg.describeQuery(query)
  const dataTypeIDs = queryParams.map((p) => p.dataTypeID)
  const subbedQuery = query.replace(/\$(\d+)/g, '%$1$L')
  const ret = await tx.query(
    `SELECT format($1, ${params.map((_, i) => `$${i + 2}`).join(', ')}) as query`,
    [subbedQuery, ...params],
    { paramTypes: [TEXT_OID, ...dataTypeIDs] },
  )
  return ret.rows[0].query
}

// Port of utils.ts debounceMutex — coalesces concurrent calls so only one
// instance of fn runs at a time; callers while running are replaced by the
// newest call (prior ones resolve undefined).
export function debounceMutex(fn) {
  let next = undefined
  let isRunning = false
  const processNext = async () => {
    if (!next) {
      isRunning = false
      return
    }
    isRunning = true
    const { args, resolve, reject } = next
    next = undefined
    try {
      const ret = await fn(...args)
      resolve(ret)
    } catch (e) {
      reject(e)
    } finally {
      processNext()
    }
  }
  return async (...args) => {
    if (next) {
      next.resolve(undefined)
    }
    const promise = new Promise((resolve, reject) => {
      next = { args, resolve, reject }
    })
    if (!isRunning) {
      processNext()
    }
    return promise
  }
}

export function rmdirRecursive(fs, path) {
  try {
    const entries = fs.readdir(path).filter((n) => n !== '.' && n !== '..')
    for (const name of entries) {
      const child = path + '/' + name
      try {
        fs.readdir(child)
        rmdirRecursive(fs, child)
      } catch (e) {
        fs.unlink(child)
      }
    }
    fs.rmdir(path)
  } catch (e) {
    try {
      fs.unlink(path)
    } catch (_) {
      /* ignore */
    }
  }
}
