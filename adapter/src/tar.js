// Port of fs/tarUtils.ts — dump/load PGDATA as a (optionally gzipped) tarball.
import { tar } from './vendor/tinytar/tar.js'
import { untar } from './vendor/tinytar/untar.js'
import constants from './vendor/tinytar/constants.js'
const { REGTYPE, DIRTYPE } = constants

export { untar }

const compressedMimeTypes = [
  'application/x-gtar',
  'application/x-tar+gzip',
  'application/x-gzip',
  'application/gzip',
]

export async function dumpTar(FS, pgDataDir, dbname = 'pgdata', compression = 'auto') {
  const tarball = createTarball(FS, pgDataDir)
  const [compressed, zipped] = await maybeZip(tarball, compression)
  const filename = dbname + (zipped ? '.tar.gz' : '.tar')
  const type = zipped ? 'application/x-gzip' : 'application/x-tar'
  if (typeof File !== 'undefined') {
    return new File([compressed], filename, { type })
  }
  return new Blob([compressed], { type })
}

export async function loadTar(FS, file, pgDataDir) {
  let tarball = new Uint8Array(await file.arrayBuffer())
  const filename =
    typeof File !== 'undefined' && file instanceof File ? file.name : undefined
  const compressed =
    compressedMimeTypes.includes(file.type) ||
    filename?.endsWith('.tgz') ||
    filename?.endsWith('.tar.gz')
  if (compressed) tarball = await unzip(tarball)

  let files
  try {
    files = untar(tarball)
  } catch (e) {
    if (e instanceof Error && e.message.includes('File is corrupted')) {
      // The file may be compressed, but had the wrong mime type, try unzipping it
      tarball = await unzip(tarball)
      files = untar(tarball)
    } else {
      throw e
    }
  }
  for (const f of files) {
    // untar yields {name, data, type}; strip leading './'
    let name = f.name
    if (name.startsWith('./')) name = name.slice(2)
    if (!name || name === '.') continue
    const path = pgDataDir + '/' + name
    if (f.type === DIRTYPE || f.name.endsWith('/')) {
      FS.mkdirTree(path)
    } else if (f.type === REGTYPE) {
      const dir = path.slice(0, path.lastIndexOf('/'))
      if (dir) FS.mkdirTree(dir)
      FS.writeFile(path, f.data)
    }
  }
}

function createTarball(FS, dir) {
  const files = []
  const walk = (cur, rel) => {
    const entries = FS.readdir(cur).filter((n) => n !== '.' && n !== '..')
    files.push({ name: rel || '.', type: DIRTYPE, data: new Uint8Array(0) })
    for (const name of entries) {
      const path = cur === '/' ? '/' + name : cur + '/' + name
      const childRel = rel ? rel + '/' + name : name
      const stat = FS.stat(path)
      if (FS.isDir(stat.mode)) {
        walk(path, childRel)
      } else {
        files.push({ name: childRel, type: REGTYPE, data: FS.readFile(path) })
      }
    }
  }
  walk(dir, '')
  return tar(files)
}

async function maybeZip(data, compression) {
  if (compression === 'none') return [data, false]
  const zipped = await gzip(data)
  return [zipped, true]
}

async function gzip(data) {
  if (typeof process !== 'undefined' && process.versions?.node) {
    const { promisify } = await import('util')
    const { gzip } = await import('zlib')
    return new Uint8Array(await promisify(gzip)(data))
  }
  const cs = new CompressionStream('gzip')
  const stream = new Blob([data]).stream().pipeThrough(cs)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function unzip(data) {
  if (typeof process !== 'undefined' && process.versions?.node) {
    const { promisify } = await import('util')
    const { gunzip } = await import('zlib')
    return new Uint8Array(await promisify(gunzip)(data))
  }
  const ds = new DecompressionStream('gzip')
  const stream = new Blob([data]).stream().pipeThrough(ds)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
