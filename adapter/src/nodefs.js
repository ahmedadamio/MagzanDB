// NodeFS — verbatim port of fs/nodefs.ts.
import * as fs from 'fs'
import * as path from 'path'
import { EmscriptenBuiltinFilesystem } from './fs.js'
import { PGDATA } from './initdb.js'

export class NodeFS extends EmscriptenBuiltinFilesystem {
  constructor(dataDir) {
    super(dataDir)
    this.rootDir = path.resolve(dataDir)
    if (!fs.existsSync(path.join(this.rootDir))) {
      fs.mkdirSync(this.rootDir, { recursive: true })
    }
  }

  async init(pg, opts) {
    this.pg = pg
    const options = {
      ...opts,
      preRun: [
        ...(opts.preRun || []),
        (mod) => {
          const nodefs = mod.FS.filesystems.NODEFS
          mod.FS.mkdirTree(PGDATA)
          mod.FS.mount(nodefs, { root: this.rootDir }, PGDATA)
        },
      ],
    }
    return { emscriptenOpts: options }
  }

  async closeFs() {
    this.pg.Module.FS.quit()
  }
}
