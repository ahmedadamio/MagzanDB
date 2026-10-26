// PGlite adapter — public API surface (port of base.ts + pglite.ts) with all
// portable protocol/codec/orchestration work delegated to the Rust
// `pglite-bridge` wasm module. The Emscripten engine lifecycle stays here.
import { Mutex } from './mutex.js'
import * as pglUtils from './utils.js'
import { parseDataDir, loadFs } from './fs.js'
import { loadTar, untar } from './tar.js'
import {
  initdb,
  ICU_DATA_PATH,
  INITDB_EXE_PATH,
  PGDATA,
  POSTGRES_EXE_PATH,
  PG_ROOT,
} from './initdb.js'
import PostgresModFactory from '../release/pglite.js'
import initBridge, { BridgeSession } from '../dist/pglite_bridge.js'
import { encode, encodeAll, decode } from './values.js'
import {
  noticeFromJson,
  databaseErrorFromJson,
  rehydrateBridgeError,
} from './errors.js'

const BRIDGE_WASM_URL = new URL('../dist/pglite_bridge_bg.wasm', import.meta.url)

let bridgeInitPromise = null
async function initBridgeModule(wasmBytes) {
  if (!bridgeInitPromise) {
    bridgeInitPromise = (async () => {
      if (wasmBytes) {
        await initBridge(wasmBytes)
      } else if (pglUtils.IN_NODE) {
        const fs = await import('fs/promises')
        await initBridge(await fs.readFile(BRIDGE_WASM_URL))
      } else {
        await initBridge(BRIDGE_WASM_URL)
      }
    })()
  }
  return bridgeInitPromise
}

// serialize.end() — 'X' code-only message (pg-protocol serializer).
const END_MESSAGE = new Uint8Array([0x58, 0, 0, 0, 4])

export class PGlite {
  static paths = {
    PG_ROOT,
    PGDATA,
    ICU_DATA_PATH,
    INITDB_EXE_PATH,
    POSTGRES_EXE_PATH,
  }

  static DEFAULT_RECV_BUF_SIZE = 1 * 1024 * 1024
  static MAX_BUFFER_SIZE = Math.pow(2, 30)

  // keep in sync with pglitec.c->POSTGRES_MAIN_LONGJMP
  #POSTGRES_MAIN_LONGJMP = 100
  #PGLITE_EXIT_ALIVE = 99

  #ready = false
  #closing = false
  #closed = false
  #relaxedDurability = false
  #running = false

  #queryMutex = new Mutex()
  #transactionMutex = new Mutex()
  #listenMutex = new Mutex()
  #fsSyncMutex = new Mutex()
  #fsSyncScheduled = false

  #notifyListeners = new Map()
  #globalNotifyListeners = new Set()

  // engine pipe buffers
  #onData = undefined
  #outputData = []
  #readOffset = 0
  #inputData = new Uint8Array(0)
  #writeOffset = 0
  #pglite_socket_write = -1
  #pglite_socket_read = -1
  #system_fn = -1
  #popen_fn = -1
  #pclose_fn = -1

  #queryReadBuffer = undefined
  #queryWriteChunks = undefined

  #extensions = {}
  #extensionsClose = []

  // Rust bridge session (BridgeSession wasm export)
  #bridge = undefined
  #constructorOptions = undefined
  #initParserIds = undefined
  #initSerializerIds = undefined
  #onNoticeCb = undefined
  #noticeHandlers = undefined
  #inTransaction = false
  externalCommandStreamFd = null
  debug = 0
  fs = undefined
  mod = undefined
  dataDir = undefined
  waitReady = undefined

  // host codec registries: id -> js fn
  #hostParsers = new Map()
  #hostSerializers = new Map()
  #nextCodecId = 1

  constructor(dataDirOrPGliteOptions = {}, options = {}) {
    if (typeof dataDirOrPGliteOptions === 'string') {
      options = { dataDir: dataDirOrPGliteOptions, ...options }
    } else {
      options = dataDirOrPGliteOptions
    }
    this.dataDir = options.dataDir

    this.debug = options?.debug ?? 0
    if (options?.relaxedDurability !== undefined) {
      this.#relaxedDurability = options.relaxedDurability
    }
    this.#extensions = options.extensions ?? {}
    this.#constructorOptions = options

    // Host-registered parser/serializer options → callback ids
    if (options.parsers) {
      for (const [k, fn] of Object.entries(options.parsers)) {
        this.#hostParsers.set(this.#nextCodecId, fn)
        this.#initParserIds = this.#initParserIds ?? {}
        this.#initParserIds[k] = this.#nextCodecId++
      }
    }
    if (options.serializers) {
      for (const [k, fn] of Object.entries(options.serializers)) {
        this.#hostSerializers.set(this.#nextCodecId, fn)
        this.#initSerializerIds = this.#initSerializerIds ?? {}
        this.#initSerializerIds[k] = this.#nextCodecId++
      }
    }

    this.waitReady = this.#init(options)
  }

  static async create(dataDirOrPGliteOptions, options) {
    const resolvedOpts =
      typeof dataDirOrPGliteOptions === 'string'
        ? { dataDir: dataDirOrPGliteOptions, ...(options ?? {}) }
        : (dataDirOrPGliteOptions ?? options ?? {})
    const pg = new PGlite(resolvedOpts)
    await pg.waitReady
    return pg
  }

  get ENV() {
    return this.mod?.ENV
  }
  get Module() {
    return this.mod
  }
  get ready() {
    return this.#ready && !this.#closing && !this.#closed
  }
  get closed() {
    return this.#closed
  }

  #log(...args) {
    if (this.debug > 0) console.log(...args)
  }
  #print(text) {
    if (this.debug) console.debug(text)
  }
  #printErr(text) {
    if (this.debug) console.error(text)
  }

  // ------------------------------------------------------------------
  // init
  // ------------------------------------------------------------------

  async #init(options) {
    if (options.fs) {
      this.fs = options.fs
    } else {
      const { dataDir, fsType } = parseDataDir(options.dataDir)
      this.fs = await loadFs(dataDir, fsType)
    }

    const extensionBundlePromises = {}
    const extensionInitFns = []

    const args = [...(this.debug ? ['-d', this.debug.toString()] : [])]

    if (!options.pgliteWasmModule) {
      pglUtils.startArtifactDownload(
        new URL('../release/pglite.wasm', import.meta.url),
      )
    }
    if (!options.initdbWasmModule) {
      pglUtils.startArtifactDownload(
        new URL('../release/initdb.wasm', import.meta.url),
      )
    }

    // Start the Rust bridge init in parallel with engine setup.
    const bridgePromise = initBridgeModule(options.bridgeWasmBytes)

    const fsBundleUrl = new URL('../release/pglite.data', import.meta.url)
    const fsBundleBufferPromise = options.fsBundle
      ? options.fsBundle.arrayBuffer()
      : pglUtils.getFsBundle(fsBundleUrl)
    let fsBundleBuffer
    fsBundleBufferPromise.then((buffer) => {
      fsBundleBuffer = buffer
    })

    const wasmMemory = new WebAssembly.Memory({
      initial: options.initialMemory ? options.initialMemory / (64 * 1024) : 2048,
      maximum: 32768,
    })

    let emscriptenOpts = {
      thisProgram: POSTGRES_EXE_PATH,
      PGLITE_ENV: {},
      WASM_PREFIX: pglUtils.WASM_PREFIX,
      arguments: args,
      noExitRuntime: true,
      wasmMemory: wasmMemory,
      stdin: () => null,
      print: (text) => {
        if (options.onStdout) {
          if (options.onStdout(text)) {
            return this.#print(text)
          }
        }
        this.#print(text)
      },
      printErr: (text) => {
        if (options.onStderr) {
          if (options.onStderr(text)) {
            return this.#printErr(text)
          }
        }
        this.#printErr(text)
      },
      instantiateWasm: (imports, successCallback) => {
        const moduleUrl = new URL('../release/pglite.wasm', import.meta.url)
        pglUtils
          .instantiateWasm(imports, moduleUrl, options.pgliteWasmModule)
          .then(({ instance, module }) => {
            successCallback(instance, module)
          })
        return {}
      },
      getPreloadedPackage: (remotePackageName, remotePackageSize) => {
        if (remotePackageName === 'pglite.data') {
          if (fsBundleBuffer.byteLength !== remotePackageSize) {
            throw new Error(
              `Invalid FS bundle size: ${fsBundleBuffer.byteLength} !== ${remotePackageSize}`,
            )
          }
          return fsBundleBuffer
        }
        throw new Error(`Unknown package: ${remotePackageName}`)
      },
      preRun: [
        (mod) => {
          mod.onRuntimeInitialized = () => {
            this.#onRuntimeInitialized(mod)
          }
        },
        (mod) => {
          // Register /dev/blob device
          const devId = mod.FS.makedev(64, 0)
          const devOpt = {
            open: (_stream) => {},
            close: (_stream) => {},
            read: (_stream, buffer, offset, length, position) => {
              const buf = this.#queryReadBuffer
              if (!buf) {
                throw new Error('No /dev/blob File or Blob provided to read from')
              }
              const contents = new Uint8Array(buf)
              if (position >= contents.length) return 0
              const size = Math.min(contents.length - position, length)
              for (let i = 0; i < size; i++) {
                buffer[offset + i] = contents[position + i]
              }
              return size
            },
            write: (_stream, buffer, offset, length, _position) => {
              this.#queryWriteChunks ??= []
              this.#queryWriteChunks.push(buffer.slice(offset, offset + length))
              return length
            },
            llseek: (stream, offset, whence) => {
              const buf = this.#queryReadBuffer
              if (!buf) {
                throw new Error('No /dev/blob File or Blob provided to llseek')
              }
              let position = offset
              if (whence === 1) {
                position += stream.position
              } else if (whence === 2) {
                position = new Uint8Array(buf).length
              }
              if (position < 0) {
                throw new mod.FS.ErrnoError(28)
              }
              return position
            },
          }
          mod.FS.registerDevice(devId, devOpt)
          mod.FS.mkdev('/dev/blob', devId)
        },
        (mod) => {
          mod.ENV.HOME = '/home/postgres'
          mod.ENV.USER = 'postgres'
          mod.ENV.LOGNAME = 'postgres'
          mod.ENV.PGDATA = PGDATA
          mod.ENV.PGUSER = options.username ?? 'postgres'
          mod.ENV.PGDATABASE = options.database ?? 'postgres'
          mod.ENV.LANG = mod.ENV.LC_COLLATE = mod.ENV.LC_CTYPE = 'en_US.UTF-8'
          mod.ENV.TZ = 'UTC'
          mod.ENV.PGTZ = 'UTC'
          mod.ENV.PGCLIENTENCODING = 'UTF8'
          mod.ENV.ICU_DATA = ICU_DATA_PATH

          if (mod.PGLITE_ENV) {
            Object.assign(mod.ENV, mod.PGLITE_ENV)
          }
        },
      ],
    }

    const { emscriptenOpts: amended } = await this.fs.init(this, emscriptenOpts)
    emscriptenOpts = amended

    const extSharedPreloadLibraries = []
    for (const [extName, ext] of Object.entries(this.#extensions)) {
      if (ext instanceof URL) {
        extensionBundlePromises[extName] = this.#loadExtensionBundle(ext)
      } else {
        const extRet = await ext.setup(this, emscriptenOpts)
        if (extRet.emscriptenOpts) {
          emscriptenOpts = extRet.emscriptenOpts
        }
        if (extRet.namespaceObj) {
          this[extName] = extRet.namespaceObj
        }
        if (extRet.bundlePath) {
          extensionBundlePromises[extName] = this.#loadExtensionBundle(
            extRet.bundlePath,
          )
        }
        if (extRet.init) extensionInitFns.push(extRet.init)
        if (extRet.close) this.#extensionsClose.push(extRet.close)
        extSharedPreloadLibraries.push(...(extRet.sharedPreloadLibraries ?? []))
      }
    }
    emscriptenOpts['pg_extensions'] = extensionBundlePromises

    await fsBundleBufferPromise

    this.mod = await PostgresModFactory(emscriptenOpts)

    this.mod.FS.chmod('/home/postgres/.pgpass', 0o0600)
    this.mod.FS.chmod(INITDB_EXE_PATH, 0o0555)
    this.mod.FS.chmod(POSTGRES_EXE_PATH, 0o0555)

    await this.fs.initialSyncFs()

    // Rust bridge session — transport wired to this module's socket pipe.
    await bridgePromise
    this.#bridge = new BridgeSession()
    this.#bridge.set_transport((msg) => this.execProtocolRawSync(msg))
    this.#bridge.set_host_callbacks(
      (id, text, oid) => {
        const fn = this.#hostParsers.get(id)
        if (!fn) return undefined
        const out = fn(text)
        return JSON.stringify(encode(out))
      },
      (id, tagged) => {
        const fn = this.#hostSerializers.get(id)
        if (!fn) return undefined
        const out = fn(decode(JSON.parse(tagged)))
        return out == null ? undefined : String(out)
      },
    )
    if (this.#initParserIds || this.#initSerializerIds) {
      this.#bridge.register_codecs(
        JSON.stringify(this.#initParserIds ?? {}),
        JSON.stringify(this.#initSerializerIds ?? {}),
      )
    }

    if (options.icuDataDir) {
      await this.#fillIcuDataDir(options.icuDataDir)
    }

    if (!options.noInitDb) {
      if (options.loadDataDir) {
        if (this.mod.FS.analyzePath(PGDATA + '/PG_VERSION').exists) {
          throw new Error('Database already exists, cannot load from tarball')
        }
        this.#log('pglite: loading data from tarball')
        await loadTar(this.mod.FS, options.loadDataDir, PGDATA)
      } else {
        if (this.mod.FS.analyzePath(PGDATA + '/PG_VERSION').exists) {
          this.#log('pglite: found DB, resuming')
        } else {
          this.#log('pglite: no db in filesystem, running initdb')

          const pgInitDbOpts = { ...options }
          pgInitDbOpts.noInitDb = true
          pgInitDbOpts.dataDir = undefined
          pgInitDbOpts.extensions = undefined
          pgInitDbOpts.loadDataDir = undefined
          // The initdb instance must run on its own scratch filesystem (see
          // reference comment: OPFS handles are exclusive per file).
          pgInitDbOpts.fs = undefined
          const pg_initDb = await PGlite.create(pgInitDbOpts)

          const initdbResult = await initdb({
            pg: pg_initDb,
            debug: options.debug,
            wasmModule: options.initdbWasmModule,
            args: options.initDbStartParams,
          })

          if (initdbResult.exitCode !== 0) {
            if (!initdbResult.stderr.includes('exists but is not empty')) {
              throw new Error(
                'INITDB failed to initialize: ' + initdbResult.stderr,
              )
            }
          }

          const pgdatatar = await pg_initDb.dumpDataDir('none')
          pg_initDb.close()
          await loadTar(this.mod.FS, pgdatatar, PGDATA)

          await this.syncToFs()
        }
      }
      await this.#loadExtensions()

      this.#handlePostgresqlConf(extSharedPreloadLibraries, options)

      this.mod._pgl_setPGliteActive(1)
      this.#startInSingleMode({
        pgDataFolder: PGDATA,
        startParams: [
          ...(options.startParams || PGlite.defaultStartParams),
          ...(this.debug ? ['-d', this.debug.toString()] : []),
        ],
      })
      this.#setPGliteActive()

      this.#ready = true

      if (options.username) {
        await this.exec(`SET ROLE ${options.username};`)
      }

      // Init array types (Rust session issues the catalog query)
      const ev = JSON.parse(this.#bridge.init_array_types(false))
      this.#dispatchEvents(ev)

      for (const initFn of extensionInitFns) {
        await initFn()
      }
    }
  }

  static defaultStartParams = [
    '--single',
    '-F',
    '-O',
    '-j',
    '-c',
    'search_path=public',
    '-c',
    'exit_on_error=false',
    '-c',
    'log_checkpoints=false',
    '-c',
    'max_worker_processes=0',
    '-c',
    'max_parallel_workers=0',
    '-c',
    'max_parallel_workers_per_gather=0',
    '-c',
    'io_method=sync',
    '-c',
    'max_parallel_maintenance_workers=0',
  ]

  #handlePostgresqlConf(extSharedPreloadLibraries, options) {
    if (extSharedPreloadLibraries.length && !options.postgresqlconf) {
      options.postgresqlconf = []
    }
    if (options.postgresqlconf) {
      let conf =
        typeof options.postgresqlconf === 'string'
          ? options.postgresqlconf
          : options.postgresqlconf.join('\n')
      if (extSharedPreloadLibraries.length) {
        const splMatch = conf.match(/^(shared_preload_libraries\s*=\s*)(.*)$/m)
        if (splMatch) {
          const existing = splMatch[2].split(',').map((s) => s.trim())
          const merged = [...new Set([...existing, ...extSharedPreloadLibraries])]
          conf = conf.replace(splMatch[0], `${splMatch[1]}${merged.join(',')}`)
        } else {
          conf += `\nshared_preload_libraries=${extSharedPreloadLibraries.join(',')}`
        }
      }
      copyToFS(
        this.mod.FS,
        `${PGDATA}/postgresql.conf`,
        new TextEncoder().encode(conf),
      )
    }
  }

  async #fillIcuDataDir(icuDataDir) {
    this.#log(
      `pglite: icuDataDir specified, removing default icu data dir at ${ICU_DATA_PATH}`,
    )
    pglUtils.rmdirRecursive(this.mod.FS, ICU_DATA_PATH)
    this.#log(`pglite: loading icu data from tarball ${icuDataDir}`)
    this.mod.FS.mkdirTree(ICU_DATA_PATH)
    await loadTar(this.mod.FS, icuDataDir, ICU_DATA_PATH)
  }

  async #loadExtensionBundle(url) {
    // Port of extensionUtils.loadExtensionBundle — .tar.gz → raw tar Blob.
    if (pglUtils.IN_NODE) {
      const fs = await import('fs')
      const zlib = await import('zlib')
      const { Writable } = await import('stream')
      const { pipeline } = await import('stream/promises')
      if (!fs.existsSync(url)) {
        throw new Error(`Extension bundle not found: ${url}`)
      }
      const chunks = []
      await pipeline(
        fs.createReadStream(url),
        zlib.createGunzip(),
        new Writable({
          write(chunk, _enc, cb) {
            chunks.push(chunk)
            cb()
          },
        }),
      )
      return new Blob(chunks)
    }
    const res = await fetch(url)
    if (!res.ok || !res.body) {
      throw new Error(`Failed to load extension bundle: ${url}`)
    } else if (res.headers.get('Content-Encoding') === 'gzip') {
      return res.blob()
    } else {
      const ds = new DecompressionStream('gzip')
      return new Response(res.body.pipeThrough(ds)).blob()
    }
  }

  async #loadExtensions() {
    // Port of extensionUtils.loadExtensions — untar each bundle into
    // WASM_PREFIX; .so files go through createPreloadedFile so Emscripten's
    // wasm preload plugin compiles them for dlopen.
    const mod = this.mod
    const promises = []
    for (const ext in mod.pg_extensions) {
      let blob
      try {
        blob = await mod.pg_extensions[ext]
      } catch (err) {
        console.error('Failed to fetch extension:', ext, err)
        continue
      }
      if (blob) {
        const bytes = new Uint8Array(await blob.arrayBuffer())
        promises.push(...this.#loadExtension(ext, bytes))
      } else {
        console.error('Could not get binary data for extension:', ext)
      }
    }
    return Promise.all(promises)
  }

  #loadExtension(_ext, bytes) {
    const mod = this.mod
    const soPreloadPromises = []
    const entries = untar(bytes).sort((a, b) =>
      a.name > b.name ? 1 : a.name < b.name ? -1 : 0,
    )
    for (const entry of entries) {
      if (entry.name.endsWith('/')) {
        const dirPath = `${mod.WASM_PREFIX}/${entry.name}`
        if (!mod.FS.analyzePath(dirPath).exists) {
          mod.FS.mkdirTree(dirPath)
        }
      } else if (!entry.name.startsWith('.')) {
        const filePath = `${mod.WASM_PREFIX}/${entry.name}`
        if (entry.name.endsWith('.so')) {
          this.#log(`pgfs:ext preloading ${filePath}`)
          const soName = entry.name.split('/').pop()
          const dirPath = filePath.slice(0, filePath.lastIndexOf('/'))
          soPreloadPromises.push(
            new Promise((resolve) => {
              mod.FS.createPreloadedFile(
                dirPath,
                soName,
                entry.data,
                true,
                true,
                (...args) => {
                  this.#log('pgfs:ext OK', filePath, args)
                  resolve()
                },
                (...args) => {
                  this.#log('pgfs:ext FAIL', filePath, args)
                  copyToFS(mod.FS, filePath, entry.data)
                  resolve()
                },
                false,
              )
            }),
          )
        } else {
          copyToFS(mod.FS, filePath, entry.data)
        }
      }
    }
    return soPreloadPromises
  }

  #onRuntimeInitialized(mod) {
    this.#system_fn = mod.addFunction((cmd_ptr) => {
      this.#log(
        `Postgres tried to execute ${mod.UTF8ToString(cmd_ptr)}, returning 1.`,
      )
      return 1
    }, 'pi')
    mod._pgl_set_system_fn(this.#system_fn)

    this.#popen_fn = mod.addFunction((cmd_ptr, mode) => {
      const smode = mod.UTF8ToString(mode)
      const args = mod.UTF8ToString(cmd_ptr)
      this.externalCommandStreamFd = this.handleExternalCmd(args, smode)
      return this.externalCommandStreamFd
    }, 'ppp')
    mod._pgl_set_popen_fn(this.#popen_fn)

    this.#pclose_fn = mod.addFunction((stream) => {
      if (stream === this.externalCommandStreamFd) {
        this.mod._fclose(this.externalCommandStreamFd)
        this.externalCommandStreamFd = null
      } else {
        throw `Unhandled pclose ${stream}`
      }
      this.#log('pclose_fn', stream)
    }, 'pi')
    mod._pgl_set_pclose_fn(this.#pclose_fn)

    this.#pglite_socket_write = mod.addFunction((ptr, length) => {
      let bytes
      try {
        bytes = this.mod.HEAPU8.subarray(ptr, ptr + length)
      } catch (e) {
        console.error('error', e)
        throw e
      }
      return this.#onData(bytes)
    }, 'iii')

    this.#pglite_socket_read = mod.addFunction(
      (ptr, max_length) => {
        let length = this.#outputData.length - this.#readOffset
        if (length > max_length) {
          length = max_length
        }
        this.mod.HEAPU8.set(
          this.#outputData.subarray(this.#readOffset, this.#readOffset + length),
          ptr,
        )
        this.#readOffset += length
        return length
      },
      'iii',
    )

    mod._pgl_set_rw_cbs(this.#pglite_socket_read, this.#pglite_socket_write)
  }

  handleExternalCmd(cmd, mode) {
    if (cmd.startsWith('locale -a') && mode === 'r') {
      const filePath = this.mod.stringToUTF8OnStack('/pglite/locale-a')
      const smode = this.mod.stringToUTF8OnStack(mode)
      return this.mod._fopen(filePath, smode)
    }
    throw new Error('Unhandled cmd')
  }

  // ------------------------------------------------------------------
  // transport — execProtocolRawSync verbatim (minus parser side-channel:
  // parsing now lives in the Rust session)
  // ------------------------------------------------------------------

  #defaultOnData(bytes) {
    const copied = bytes.slice()
    let requiredSize = this.#writeOffset + copied.length
    if (requiredSize > this.#inputData.length) {
      const newSize =
        this.#inputData.length + (this.#inputData.length >> 1) + requiredSize
      if (requiredSize > PGlite.MAX_BUFFER_SIZE) {
        requiredSize = PGlite.MAX_BUFFER_SIZE
      }
      const newBuffer = new Uint8Array(newSize)
      newBuffer.set(this.#inputData.subarray(0, this.#writeOffset))
      this.#inputData = newBuffer
    }
    this.#inputData.set(copied, this.#writeOffset)
    this.#writeOffset += copied.length
    return bytes.length
  }

  execProtocolRawSync(message) {
    const mod = this.mod

    this.#readOffset = 0
    this.#writeOffset = 0
    this.#outputData = message

    if (!this.#onData) {
      this.#onData = (b) => this.#defaultOnData(b)
    }

    if (this.#inputData.length !== PGlite.DEFAULT_RECV_BUF_SIZE) {
      this.#inputData = new Uint8Array(PGlite.DEFAULT_RECV_BUF_SIZE)
    }

    if (message[0] === 'X'.charCodeAt(0)) {
      return new Uint8Array(0)
    }

    if (message[0] === 0) {
      return this.#processStartupPacket(message)
    }

    try {
      while (
        this.#readOffset < message.length ||
        mod._pq_buffer_remaining_data() > 0
      ) {
        let sp
        try {
          sp = mod.stackSave()
          mod._PostgresMainLoopOnce()
        } catch (e) {
          mod.stackRestore(sp)
          if (e.status === this.#POSTGRES_MAIN_LONGJMP) {
            mod._PostgresMainLongJmp()
          }
        }
      }
    } finally {
      mod._PostgresSendReadyForQueryIfNecessary()
      mod._pgl_pq_flush()
    }

    this.#outputData = []

    if (this.#writeOffset) {
      return new Uint8Array(this.#inputData.subarray(0, this.#writeOffset))
    }
    return new Uint8Array(0)
  }

  #processStartupPacket(message) {
    this.#readOffset = 0
    this.#writeOffset = 0
    this.#outputData = message
    const myProcPort = this.mod._pgl_getMyProcPort()
    const result = this.mod._ProcessStartupPacket(myProcPort, true, true)
    if (result !== 0) {
      throw new Error(`Cannot process startup packet + ${message.toString()}`)
    }
    this.mod._pgl_sendConnData()
    this.mod._pgl_pq_flush()
    this.#outputData = []
    if (this.#writeOffset) return this.#inputData.subarray(0, this.#writeOffset)
    return new Uint8Array(0)
  }

  // ------------------------------------------------------------------
  // events — dispatch notices/notifications collected by the Rust session
  // ------------------------------------------------------------------

  #dispatchEvents(events) {
    if (!events) return
    for (const n of events.notices ?? []) {
      const notice = noticeFromJson(n)
      if (this.debug > 0) console.warn(notice)
      this.#onNoticeCb?.(notice)
      this.#noticeHandlers?.forEach((cb) => queueMicrotask(() => cb(notice)))
    }
    for (const n of events.notifications ?? []) {
      const listeners = this.#notifyListeners.get(n.channel)
      if (listeners) {
        listeners.forEach((cb) => queueMicrotask(() => cb(n.payload)))
      }
      this.#globalNotifyListeners.forEach((cb) => {
        queueMicrotask(() => cb(n.channel, n.payload))
      })
    }
  }

  #optionsJson(options) {
    if (!options) return '{}'
    const j = {}
    if (options.rowMode) j.rowMode = options.rowMode
    if (options.paramTypes) j.paramTypes = options.paramTypes
    if (options.parsers) {
      j.parsers = {}
      for (const [k, fn] of Object.entries(options.parsers)) {
        const id = this.#nextCodecId++
        this.#hostParsers.set(id, fn)
        j.parsers[k] = id
      }
    }
    if (options.serializers) {
      j.serializers = {}
      for (const [k, fn] of Object.entries(options.serializers)) {
        const id = this.#nextCodecId++
        this.#hostSerializers.set(id, fn)
        j.serializers[k] = id
      }
    }
    if (options.onNotice) j.onNotice = true
    if (options.blob) j.blob = true
    return JSON.stringify(j)
  }

  #materializeResults(resultsJson, options, blob) {
    const out = []
    for (const r of resultsJson) {
      const fields = r.fields ?? []
      let rows
      if (options?.rowMode === 'array') {
        rows = r.rows.map((row) => row.map((c) => decode(c)))
      } else {
        rows = r.rows.map((row) =>
          Object.fromEntries(
            row.map((c, i) => [fields[i]?.name, decode(c)]),
          ),
        )
      }
      const res = {
        rows,
        fields,
        affectedRows: r.affectedRows,
      }
      if (r.command != null) res.command = r.command
      if (r.rowCount != null) res.rowCount = r.rowCount
      if (blob) res.blob = blob
      out.push(res)
    }
    return out
  }

  // ------------------------------------------------------------------
  // public API
  // ------------------------------------------------------------------

  async _checkReady() {
    if (this.#closing) throw new Error('PGlite is closing')
    if (this.#closed) throw new Error('PGlite is closed')
    if (!this.#ready) await this.waitReady
  }

  async _handleBlob(blob) {
    this.#queryReadBuffer = blob ? await blob.arrayBuffer() : undefined
  }
  async _cleanupBlob() {
    this.#queryReadBuffer = undefined
  }
  async _getWrittenBlob() {
    if (!this.#queryWriteChunks) return undefined
    const blob = new Blob(this.#queryWriteChunks)
    this.#queryWriteChunks = undefined
    return blob
  }

  _runExclusiveQuery(fn) {
    return this.#queryMutex.runExclusive(fn)
  }
  _runExclusiveTransaction(fn) {
    return this.#transactionMutex.runExclusive(fn)
  }
  _runExclusiveListen(fn) {
    return this.#listenMutex.runExclusive(fn)
  }
  async runExclusive(fn) {
    return await this._runExclusiveQuery(fn)
  }

  async query(query, params = [], options) {
    await this._checkReady()
    return await this._runExclusiveTransaction(async () => {
      return await this.#runQuery(query, params, options)
    })
  }

  async #runQuery(query, params, options) {
    return await this._runExclusiveQuery(() =>
      this._queryNoMutex(query, params, options),
    )
  }

  // Worker-facing variant: the query mutex is already held by the client's
  // _acquireQueryLock RPC, so this must not re-acquire it.
  async _queryNoMutex(query, params, options) {
    this.#onNoticeCb = options?.onNotice
    await this._handleBlob(options?.blob)
    try {
      const raw = this.#bridge.query(
        query,
        encodeAll(params),
        this.#optionsJson(options),
      )
      const { result, events } = JSON.parse(raw)
      this.#dispatchEvents(events)
      const [materialized] = this.#materializeResults([result], options)
      const res = materialized
      if (!this.#inTransaction) await this.syncToFs()
      const blob = await this._getWrittenBlob()
      if (blob) res.blob = blob
      return res
    } catch (e) {
      if (e && e.events) this.#dispatchEvents(e.events)
      throw rehydrateBridgeError(e) ?? e
    } finally {
      this.#onNoticeCb = undefined
      await this._cleanupBlob()
    }
  }

  async sql(sqlStrings, ...params) {
    const { query, params: actualParams } = queryTemplate(sqlStrings, ...params)
    return await this.query(query, actualParams)
  }

  async exec(query, options) {
    await this._checkReady()
    return await this._runExclusiveTransaction(async () => {
      return await this.#runExec(query, options)
    })
  }

  async #runExec(query, options) {
    return await this._runExclusiveQuery(() => this._execNoMutex(query, options))
  }

  // Worker-facing variant — see _queryNoMutex.
  async _execNoMutex(query, options) {
    this.#onNoticeCb = options?.onNotice
    await this._handleBlob(options?.blob)
    try {
      const raw = this.#bridge.exec(query, this.#optionsJson(options))
      const { results, events } = JSON.parse(raw)
      this.#dispatchEvents(events)
      const res = this.#materializeResults(results, options)
      if (!this.#inTransaction) await this.syncToFs()
      const blob = await this._getWrittenBlob()
      if (blob) {
        for (const r of res) r.blob = blob
      }
      return res
    } catch (e) {
      if (e && e.events) this.#dispatchEvents(e.events)
      throw rehydrateBridgeError(e) ?? e
    } finally {
      this.#onNoticeCb = undefined
      await this._cleanupBlob()
    }
  }

  async describeQuery(query, options) {
    await this._checkReady()
    let result
    try {
      const raw = this.#bridge.describe_query(query, this.#optionsJson(options))
      const parsed = JSON.parse(raw)
      result = parsed.result
      this.#dispatchEvents(parsed.events)
    } catch (e) {
      if (e && e.events) this.#dispatchEvents(e.events)
      throw rehydrateBridgeError(e) ?? e
    }
    // NOTE(port): hasSerializer/hasParser flags stand in for the actual fn
    // refs until the codec registry bridge lands.
    return {
      queryParams: result.queryParams.map((p) => ({
        dataTypeID: p.dataTypeID,
        serializer: p.hasSerializer ? this.#describeSerializerPlaceholder : undefined,
      })),
      resultFields: result.resultFields.map((f) => ({
        name: f.name,
        dataTypeID: f.dataTypeID,
        parser: f.hasParser ? this.#describeParserPlaceholder : undefined,
      })),
    }
  }

  #describeSerializerPlaceholder = (v) => String(v)
  #describeParserPlaceholder = (v) => v

  async transaction(callback) {
    await this._checkReady()
    return await this._runExclusiveTransaction(async () => {
      await this.#runExec('BEGIN')
      this.#inTransaction = true
      this.#bridge.set_in_transaction(true)

      let closed = false
      const checkClosed = () => {
        if (closed) throw new Error('Transaction is closed')
      }

      const tx = {
        query: async (query, params = [], options) => {
          checkClosed()
          return await this.#runQuery(query, params, options)
        },
        sql: async (sqlStrings, ...params) => {
          checkClosed()
          const { query, params: actualParams } = queryTemplate(
            sqlStrings,
            ...params,
          )
          return await this.#runQuery(query, actualParams)
        },
        exec: async (query, options) => {
          checkClosed()
          return await this.#runExec(query, options)
        },
        rollback: async () => {
          checkClosed()
          await this.#runExec('ROLLBACK')
          closed = true
        },
        listen: async (channel, callback) => {
          checkClosed()
          return await this.listen(channel, callback, tx)
        },
        get closed() {
          return closed
        },
      }

      try {
        const result = await callback(tx)
        if (!closed) {
          closed = true
          await this.#runExec('COMMIT')
        }
        this.#inTransaction = false
        this.#bridge.set_in_transaction(false)
        return result
      } catch (e) {
        if (!closed) {
          closed = true
          await this.#runExec('ROLLBACK')
        }
        this.#inTransaction = false
        this.#bridge.set_in_transaction(false)
        throw e
      }
    })
  }

  isInTransaction() {
    const result = this.mod._IsTransactionBlock()
    return result !== 0
  }

  // ------------------------------------------------------------------
  // execProtocol passthroughs
  // ------------------------------------------------------------------

  async execProtocol(message, { syncToFs = true, throwOnError = true, onNotice } = {}) {
    this.#onNoticeCb = onNotice
    try {
      const out = this.#bridge.exec_protocol(
        message,
        JSON.stringify({ syncToFs, throwOnError, onNotice: !!onNotice }),
      )
      this.#dispatchEvents(out.events)
      if (syncToFs) await this.syncToFs()
      return { messages: out.messages, data: out.data }
    } catch (e) {
      if (e && e.events) this.#dispatchEvents(e.events)
      throw rehydrateBridgeError(e) ?? e
    } finally {
      this.#onNoticeCb = undefined
      this.#onData = undefined
    }
  }

  async execProtocolStream(message, { syncToFs = true, throwOnError = true, onNotice } = {}) {
    this.#onNoticeCb = onNotice
    try {
      const out = JSON.parse(
        this.#bridge.exec_protocol_stream(
          message,
          JSON.stringify({ syncToFs, throwOnError, onNotice: !!onNotice }),
        ),
      )
      this.#dispatchEvents(out.events)
      if (syncToFs) await this.syncToFs()
      return out.messages
    } catch (e) {
      if (e && e.events) this.#dispatchEvents(e.events)
      throw rehydrateBridgeError(e) ?? e
    } finally {
      this.#onNoticeCb = undefined
      this.#onData = undefined
    }
  }

  async execProtocolRaw(message, { syncToFs = true } = {}) {
    const data = this.execProtocolRawSync(message)
    if (syncToFs) await this.syncToFs()
    return data
  }

  async execProtocolRawStream(message, { syncToFs = true, onRawData }) {
    this.#onData = (bytes) => {
      onRawData(bytes)
      return bytes.length
    }
    try {
      this.execProtocolRawSync(message)
      if (syncToFs) await this.syncToFs()
    } finally {
      this.#onData = undefined
    }
  }

  // ------------------------------------------------------------------
  // codecs — db.parsers / db.serializers / refreshArrayTypes
  // ------------------------------------------------------------------

  // Live views of the Rust session codec maps. Values are thin wrappers that
  // delegate back into the session; keys enumerate exactly like the
  // reference's `{oid|name: fn}` tables.
  #codecViews = { parsers: undefined, serializers: undefined }

  get parsers() {
    if (!this.#codecViews.parsers) {
      const keys = JSON.parse(this.#bridge.codec_key_list()).parsers
      const t = {}
      for (const k of keys) {
        const key = k.oid !== undefined ? k.oid : k.name
        t[key] = (x, _tid) =>
          decode(JSON.parse(this.#bridge.parse_value(String(x), k.oid ?? k.to ?? 0)))
      }
      this.#codecViews.parsers = t
    }
    return this.#codecViews.parsers
  }

  get serializers() {
    if (!this.#codecViews.serializers) {
      const keys = JSON.parse(this.#bridge.codec_key_list()).serializers
      const t = {}
      for (const k of keys) {
        const key = k.oid !== undefined ? k.oid : k.name
        t[key] = (x) =>
          this.#bridge.serialize_value(k.oid ?? k.to ?? 0, JSON.stringify(encode(x)))
      }
      this.#codecViews.serializers = t
    }
    return this.#codecViews.serializers
  }

  async refreshArrayTypes() {
    await this._checkReady()
    const ev = JSON.parse(this.#bridge.init_array_types(true))
    this.#dispatchEvents(ev)
    this.#codecViews = { parsers: undefined, serializers: undefined }
  }

  // ------------------------------------------------------------------
  // notifications
  // ------------------------------------------------------------------

  async listen(channel, callback, tx) {
    return this._runExclusiveListen(() => this.#listen(channel, callback, tx))
  }

  async #listen(channel, callback, tx) {
    const pgChannel = pglUtils.toPostgresName(channel)
    const pg = tx ?? this
    if (!this.#notifyListeners.has(pgChannel)) {
      this.#notifyListeners.set(pgChannel, new Set())
    }
    this.#notifyListeners.get(pgChannel).add(callback)
    try {
      await pg.exec(`LISTEN ${channel}`)
    } catch (e) {
      this.#notifyListeners.get(pgChannel).delete(callback)
      if (this.#notifyListeners.get(pgChannel)?.size === 0) {
        this.#notifyListeners.delete(pgChannel)
      }
      throw e
    }
    return async (tx) => {
      await this.unlisten(pgChannel, callback, tx)
    }
  }

  async unlisten(channel, callback, tx) {
    return this._runExclusiveListen(() => this.#unlisten(channel, callback, tx))
  }

  async #unlisten(channel, callback, tx) {
    const pgChannel = pglUtils.toPostgresName(channel)
    const pg = tx ?? this
    const cleanUp = async () => {
      await pg.exec(`UNLISTEN ${channel}`)
      if (this.#notifyListeners.get(pgChannel)?.size === 0) {
        this.#notifyListeners.delete(pgChannel)
      }
    }
    if (callback) {
      this.#notifyListeners.get(pgChannel)?.delete(callback)
      if (this.#notifyListeners.get(pgChannel)?.size === 0) {
        await cleanUp()
      }
    } else {
      await cleanUp()
    }
  }

  onNotification(callback) {
    this.#globalNotifyListeners.add(callback)
    return () => {
      this.#globalNotifyListeners.delete(callback)
    }
  }

  offNotification(callback) {
    this.#globalNotifyListeners.delete(callback)
  }

  // ------------------------------------------------------------------
  // lifecycle
  // ------------------------------------------------------------------

  async syncToFs() {
    if (this.#fsSyncScheduled) return
    this.#fsSyncScheduled = true
    const doSync = async () => {
      await this.#fsSyncMutex.runExclusive(async () => {
        this.#fsSyncScheduled = false
        await this.fs.syncToFs(this.#relaxedDurability)
      })
    }
    if (this.#relaxedDurability) {
      doSync()
    } else {
      await doSync()
    }
  }

  async dumpDataDir(compression) {
    const data = await this.#queryMutex.runExclusive(async () => {
      await this._checkReady()
      const dbname = this.dataDir?.split('/').pop() ?? 'pgdata'
      return this.fs.dumpTar(dbname, compression)
    })
    return data
  }

  async close() {
    await this._checkReady()
    await this.#queryMutex.runExclusive(async () => {
      await this._checkReady()
      this.#closing = true
    })

    for (const closeFn of this.#extensionsClose) {
      await closeFn()
    }

    try {
      this.mod._pgl_setPGliteActive(0)
      await this.execProtocol(END_MESSAGE)
      this.mod._pgl_run_atexit_funcs()
    } catch (e) {
      if (e?.name === 'ExitStatus' && e?.status === 0) {
        // Database closed successfully
      } else {
        this.#log('An error occured while closing the db', String(e))
      }
    } finally {
      this.mod.removeFunction(this.#pglite_socket_read)
      this.mod.removeFunction(this.#pglite_socket_write)
    }

    await this.fs.closeFs()

    this.#closed = true
    this.#closing = false
    this.#ready = false
    this.#running = false

    try {
      this.mod._emscripten_force_exit(0)
    } catch (e) {
      this.#log(e)
      if (e.status !== 0) {
        this.#log('Error when exiting', String(e))
      }
    } finally {
      this.mod = undefined
    }
  }

  async [Symbol.asyncDispose]() {
    await this.close()
  }

  callMain(args) {
    return this.mod.callMain(args)
  }

  #setPGliteActive() {
    if (this.#running) {
      throw new Error('PGlite single mode already running')
    }
    this.mod._pgl_startPGlite()
    this.#running = true
  }

  #startInSingleMode(opts) {
    const singleModeArgs = [
      ...opts.startParams,
      '-D',
      opts.pgDataFolder,
      this.mod.ENV.PGDATABASE,
    ]
    const mainReturnValue = this.mod.callMain(singleModeArgs)
    if (mainReturnValue !== this.#PGLITE_EXIT_ALIVE) {
      throw new Error('PGlite failed to initialize properly')
    }
  }

  copyToFS(filePath, data, mode) {
    copyToFS(this.mod.FS, filePath, data, mode)
  }

  async clone() {
    const dump = await this.dumpDataDir('none')
    return PGlite.create({ loadDataDir: dump, extensions: this.#extensions })
  }
}

function copyToFS(FS, filePath, data, mode) {
  const dir = filePath.slice(0, filePath.lastIndexOf('/'))
  if (dir) FS.mkdirTree(dir)
  FS.writeFile(filePath, data)
  if (mode !== undefined) FS.chmod(filePath, mode)
}

// ------------------------------------------------------------------
// templating helpers (public API) — markers consumed by bridge query_template
// ------------------------------------------------------------------

export function sql(strings, ...values) {
  return {
    __tcont: {
      strings: [...strings],
      raw: [...(strings.raw ?? strings)],
      values,
    },
  }
}

export function identifier(strings, ...values) {
  return { __tpart: `"${String.raw(strings, ...values)}"` }
}

export function raw(strings, ...values) {
  return { __tpart: String.raw(strings, ...values) }
}

function encodeTemplateValue(v) {
  if (v && typeof v === 'object') {
    if (v.__tpart !== undefined) return { $part: v.__tpart }
    if (v.__tcont) {
      return {
        $cont: {
          strings: v.__tcont.strings,
          raw: v.__tcont.raw,
          values: v.__tcont.values.map(encodeTemplateValue),
        },
      }
    }
  }
  return encode(v)
}

export function queryTemplate(strings, ...values) {
  // Module-level function used by db.sql`...`: collapse in Rust.
  const sess = new BridgeSession() // transport unused — pure function
  const out = JSON.parse(
    sess.query_template(
      JSON.stringify([...strings]),
      JSON.stringify([...(strings.raw ?? strings)]),
      JSON.stringify(values.map(encodeTemplateValue)),
    ),
  )
  return { query: out.query, params: out.params.map(decode) }
}
