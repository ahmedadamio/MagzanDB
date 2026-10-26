// Filesystem layer — host-side port of packages/pglite/src/fs/.
// Emscripten builtin filesystems (MEMFS/NODEFS/IDBFS) + the custom BaseFilesystem
// bridge (EMFS) — copied nearly verbatim since it's all host capability code.
import { dumpTar } from './tar.js'
import { PGDATA } from './initdb.js'

export function parseDataDir(dataDir) {
  let fsType
  if (dataDir?.startsWith('file://')) {
    dataDir = dataDir.slice(7)
    if (!dataDir) throw new Error('Invalid dataDir, must be a valid path')
    fsType = 'nodefs'
  } else if (dataDir?.startsWith('idb://')) {
    dataDir = dataDir.slice(6)
    fsType = 'idbfs'
  } else if (dataDir?.startsWith('opfs-ahp://')) {
    dataDir = dataDir.slice(11)
    fsType = 'opfs-ahp'
  } else if (!dataDir || dataDir?.startsWith('memory://')) {
    fsType = 'memoryfs'
  } else {
    fsType = 'nodefs'
  }
  return { dataDir, fsType }
}

export async function loadFs(dataDir, fsType) {
  let fs
  if (dataDir && fsType === 'nodefs') {
    const { NodeFS } = await import('./nodefs.js')
    fs = new NodeFS(dataDir)
  } else if (dataDir && fsType === 'idbfs') {
    fs = new IdbFs(dataDir)
  } else if (dataDir && fsType === 'opfs-ahp') {
    const { OpfsAhpFS } = await import('./opfs-ahp.js')
    fs = new OpfsAhpFS(dataDir)
  } else {
    fs = new MemoryFS()
  }
  return fs
}

export class EmscriptenBuiltinFilesystem {
  constructor(dataDir) {
    this.dataDir = dataDir
  }
  async init(pg, emscriptenOptions) {
    this.pg = pg
    return { emscriptenOpts: emscriptenOptions }
  }
  async syncToFs() {}
  async initialSyncFs() {}
  async closeFs() {}
  async dumpTar(dbname, compression) {
    return dumpTar(this.pg.Module.FS, PGDATA, dbname, compression)
  }
}

export class MemoryFS extends EmscriptenBuiltinFilesystem {
  async closeFs() {
    this.pg.Module.FS.quit()
  }
}

export class IdbFs extends EmscriptenBuiltinFilesystem {
  async init(pg, emscriptenOptions) {
    this.pg = pg
    const options = {
      ...emscriptenOptions,
      preRun: [
        ...(emscriptenOptions.preRun || []),
        (mod) => {
          const idbfs = mod.FS.filesystems.IDBFS
          mod.FS.mkdirTree(PGDATA)
          mod.FS.mount(idbfs, {}, PGDATA)
        },
      ],
    }
    return { emscriptenOpts: options }
  }
  async syncToFs() {
    await new Promise((resolve, reject) => {
      this.pg.Module.FS.syncfs(false, (err) => (err ? reject(err) : resolve()))
    })
  }
  async initialSyncFs() {
    await new Promise((resolve, reject) => {
      this.pg.Module.FS.syncfs(true, (err) => (err ? reject(err) : resolve()))
    })
  }
  async closeFs() {
    this.pg.Module.FS.quit()
  }
}

export const ERRNO_CODES = {
  EBADF: 8,
  EBADFD: 127,
  EEXIST: 20,
  EINVAL: 28,
  EISDIR: 31,
  ENODEV: 43,
  ENOENT: 44,
  ENOTDIR: 54,
  ENOTEMPTY: 55,
}

/**
 * Base class for custom virtual filesystems — verbatim port of
 * BaseFilesystem + createEmscriptenFS from fs/base.ts.
 */
export class BaseFilesystem {
  constructor(dataDir, { debug = false } = {}) {
    this.dataDir = dataDir
    this.debug = debug
  }
  async syncToFs() {}
  async initialSyncFs() {}
  async closeFs() {}
  async dumpTar(dbname, compression) {
    return dumpTar(this.pg.Module.FS, PGDATA, dbname, compression)
  }
  async init(pg, emscriptenOptions) {
    this.pg = pg
    const options = {
      ...emscriptenOptions,
      preRun: [
        ...(emscriptenOptions.preRun || []),
        (mod) => {
          const EMFS = createEmscriptenFS(mod, this)
          mod.FS.mkdirTree(PGDATA)
          mod.FS.mount(EMFS, {}, PGDATA)
        },
      ],
    }
    return { emscriptenOpts: options }
  }
}

const createEmscriptenFS = (Module, baseFS) => {
  const FS = Module.FS
  const log = baseFS.debug ? console.log : null
  const EMFS = {
    tryFSOperation(f) {
      try {
        return f()
      } catch (e) {
        if (!e.code) throw e
        if (e.code === 'UNKNOWN') throw new FS.ErrnoError(ERRNO_CODES.EINVAL)
        throw new FS.ErrnoError(e.code)
      }
    },
    mount(_mount) {
      return EMFS.createNode(null, '/', 16384 | 511, 0)
    },
    syncfs(_mount, _populate, _done) {},
    createNode(parent, name, mode, _dev) {
      if (!FS.isDir(mode) && !FS.isFile(mode)) {
        throw new FS.ErrnoError(28)
      }
      const node = FS.createNode(parent, name, mode)
      node.node_ops = EMFS.node_ops
      node.stream_ops = EMFS.stream_ops
      return node
    },
    getMode(path) {
      log?.('getMode', path)
      return EMFS.tryFSOperation(() => baseFS.lstat(path).mode)
    },
    realPath(node) {
      const parts = []
      while (node.parent !== node) {
        parts.push(node.name)
        node = node.parent
      }
      parts.push(node.mount.opts.root)
      parts.reverse()
      return parts.join('/')
    },
    node_ops: {
      getattr(node) {
        log?.('getattr', EMFS.realPath(node))
        const path = EMFS.realPath(node)
        return EMFS.tryFSOperation(() => {
          const stats = baseFS.lstat(path)
          return {
            ...stats,
            dev: 0,
            ino: node.id,
            nlink: 1,
            rdev: node.rdev,
            atime: new Date(stats.atime),
            mtime: new Date(stats.mtime),
            ctime: new Date(stats.ctime),
          }
        })
      },
      setattr(node, attr) {
        log?.('setattr', EMFS.realPath(node), attr)
        const path = EMFS.realPath(node)
        EMFS.tryFSOperation(() => {
          if (attr.mode !== undefined) baseFS.chmod(path, attr.mode)
          if (attr.size !== undefined) baseFS.truncate(path, attr.size)
          if (attr.timestamp !== undefined) {
            baseFS.utimes(path, attr.timestamp, attr.timestamp)
          }
          if (attr.size !== undefined) baseFS.truncate(path, attr.size)
        })
      },
      lookup(parent, name) {
        log?.('lookup', EMFS.realPath(parent), name)
        const path = [EMFS.realPath(parent), name].join('/')
        const mode = EMFS.getMode(path)
        return EMFS.createNode(parent, name, mode)
      },
      mknod(parent, name, mode, dev) {
        log?.('mknod', EMFS.realPath(parent), name, mode, dev)
        const node = EMFS.createNode(parent, name, mode, dev)
        const path = EMFS.realPath(node)
        return EMFS.tryFSOperation(() => {
          if (FS.isDir(node.mode)) {
            baseFS.mkdir(path, { mode })
          } else {
            baseFS.writeFile(path, '', { mode })
          }
          return node
        })
      },
      rename(oldNode, newDir, newName) {
        log?.('rename', EMFS.realPath(oldNode), EMFS.realPath(newDir), newName)
        const oldPath = EMFS.realPath(oldNode)
        const newPath = [EMFS.realPath(newDir), newName].join('/')
        EMFS.tryFSOperation(() => baseFS.rename(oldPath, newPath))
        oldNode.name = newName
      },
      unlink(parent, name) {
        log?.('unlink', EMFS.realPath(parent), name)
        const path = [EMFS.realPath(parent), name].join('/')
        try {
          baseFS.unlink(path)
        } catch (e) {}
      },
      rmdir(parent, name) {
        log?.('rmdir', EMFS.realPath(parent), name)
        const path = [EMFS.realPath(parent), name].join('/')
        return EMFS.tryFSOperation(() => baseFS.rmdir(path))
      },
      readdir(node) {
        log?.('readdir', EMFS.realPath(node))
        const path = EMFS.realPath(node)
        return EMFS.tryFSOperation(() => baseFS.readdir(path))
      },
      symlink(parent, newName, oldPath) {
        log?.('symlink', EMFS.realPath(parent), newName, oldPath)
        throw new FS.ErrnoError(63)
      },
      readlink(node) {
        log?.('readlink', EMFS.realPath(node))
        throw new FS.ErrnoError(63)
      },
    },
    stream_ops: {
      open(stream) {
        log?.('open stream', EMFS.realPath(stream.node))
        const path = EMFS.realPath(stream.node)
        return EMFS.tryFSOperation(() => {
          if (FS.isFile(stream.node.mode)) {
            stream.shared.refcount = 1
            stream.nfd = baseFS.open(path)
          }
        })
      },
      close(stream) {
        log?.('close stream', EMFS.realPath(stream.node))
        return EMFS.tryFSOperation(() => {
          if (
            FS.isFile(stream.node.mode) &&
            stream.nfd &&
            --stream.shared.refcount === 0
          ) {
            baseFS.close(stream.nfd)
          }
        })
      },
      dup(stream) {
        log?.('dup stream', EMFS.realPath(stream.node))
        stream.shared.refcount++
      },
      read(stream, buffer, offset, length, position) {
        log?.('read stream', EMFS.realPath(stream.node), offset, length, position)
        if (length === 0) return 0
        return EMFS.tryFSOperation(() =>
          baseFS.read(stream.nfd, buffer, offset, length, position),
        )
      },
      write(stream, buffer, offset, length, position) {
        log?.('write stream', EMFS.realPath(stream.node), offset, length, position)
        return EMFS.tryFSOperation(() =>
          baseFS.write(
            stream.nfd,
            buffer.buffer,
            offset,
            length,
            position,
          ),
        )
      },
      llseek(stream, offset, whence) {
        log?.('llseek stream', EMFS.realPath(stream.node), offset, whence)
        let position = offset
        if (whence === 1) {
          position += stream.position
        } else if (whence === 2) {
          if (FS.isFile(stream.node.mode)) {
            EMFS.tryFSOperation(() => {
              const stat = baseFS.fstat(stream.nfd)
              position += stat.size
            })
          }
        }
        if (position < 0) throw new FS.ErrnoError(28)
        return position
      },
      mmap(stream, length, position, prot, flags) {
        log?.('mmap stream', EMFS.realPath(stream.node), length, position, prot, flags)
        if (!FS.isFile(stream.node.mode)) {
          throw new FS.ErrnoError(ERRNO_CODES.ENODEV)
        }
        const ptr = Module.mmapAlloc(length)
        EMFS.stream_ops.read(stream, Module.HEAPU8, ptr, length, position)
        return { ptr, allocated: true }
      },
      msync(stream, buffer, offset, length, mmapFlags) {
        log?.('msync stream', EMFS.realPath(stream.node), offset, length, mmapFlags)
        EMFS.stream_ops.write(stream, buffer, 0, length, offset)
        return 0
      },
    },
  }
  return EMFS
}
