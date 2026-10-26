// Port of src/initdb.ts — runs the initdb Emscripten module against a scratch
// PGlite instance's FS (mounted via PROXYFS).
import InitdbModFactory from '../release/initdb.js'
import parse from './argsParser.js'
import * as pglUtils from './utils.js'

export const PG_ROOT = '/pglite'
export const PGDATA = PG_ROOT + '/data'
export const ICU_DATA_PATH = PG_ROOT + '/icu'
export const INITDB_EXE_PATH = PG_ROOT + '/bin/initdb'
export const POSTGRES_EXE_PATH = PG_ROOT + '/bin/postgres'

const pgstdoutPath = PG_ROOT + '/pgstdout'
const pgstdinPath = PG_ROOT + '/pgstdin'

function assert(condition, message) {
  if (!condition) {
    throw new Error(message ?? 'Assertion failed')
  }
}

function log(debug, ...args) {
  if (debug && debug > 0) {
    console.log('initdb: ', ...args)
  }
}

function getArgs(cmd) {
  const a = []
  const parsed = parse(cmd)
  for (let i = 0; i < parsed.length; i++) {
    const token = parsed[i]
    if (typeof token === 'object' && 'op' in token) break
    if (typeof token === 'string') a.push(token)
  }
  return a
}

async function execInitdb({ pg, debug, args, wasmModule }) {
  let system_fn, popen_fn, pclose_fn

  let needToCallPGmain = false
  let postgresArgs = []

  let pgMainResult = 0

  let initdb_stdin_fd = -1
  let initdb_stdout_fd = -1
  let stderrOutput = ''
  let stdoutOutput = ''

  const origHEAPU8 = pg.Module.HEAPU8.slice()

  const callPgMain = (args) => {
    const firstArg = args.shift()
    log(debug, 'initdb: firstArg', firstArg)
    assert(firstArg === '/pglite/bin/postgres', `trying to execute ${firstArg}`)

    pg.Module.HEAPU8.set(origHEAPU8)

    log(debug, 'executing pg main with', args)
    const result = pg.callMain(args)

    log(debug, result)

    postgresArgs = []

    return result
  }

  const emscriptenOpts = {
    arguments: args,
    noExitRuntime: false,
    thisProgram: INITDB_EXE_PATH,
    stdin: () => null,
    print: (text) => {
      stdoutOutput += text
      log(debug, 'initdbout', text)
    },
    printErr: (text) => {
      stderrOutput += text
      log(debug, 'initdberr', text)
    },
    instantiateWasm: (imports, successCallback) => {
      const moduleUrl = new URL('../release/initdb.wasm', import.meta.url)
      pglUtils
        .instantiateWasm(imports, moduleUrl, wasmModule)
        .then(({ instance, module }) => {
          successCallback(instance, module)
        })
      return {}
    },
    locateFile: (path, prefix) => {
      if (path.endsWith('.so')) {
        return '/pglite/lib/' + path
      }
      return prefix + path
    },
    preRun: [
      (mod) => {
        mod.ENV.PGDATA = PGDATA
        mod.ENV.HOME = '/home/postgres'
        mod.ENV.USER = 'postgres'
        mod.ENV.LOGNAME = 'postgres'
        mod.ENV.ICU_DATA = ICU_DATA_PATH
        // Match the backend (see pglite.ts). Without this, initdb writes the
        // host's zone to postgresql.conf as a fixed offset such as 'Etc/GMT+5'.
        mod.ENV.TZ = 'UTC'
      },
      (mod) => {
        mod.onRuntimeInitialized = () => {
          system_fn = mod.addFunction((cmd_ptr) => {
            postgresArgs = getArgs(mod.UTF8ToString(cmd_ptr))
            return callPgMain(postgresArgs)
          }, 'pi')

          mod._pgl_set_system_fn(system_fn)

          popen_fn = mod.addFunction((cmd_ptr, mode) => {
            const smode = mod.UTF8ToString(mode)
            postgresArgs = getArgs(mod.UTF8ToString(cmd_ptr))

            if (smode === 'r') {
              pgMainResult = callPgMain(postgresArgs)
              return initdb_stdin_fd
            } else {
              if (smode === 'w') {
                needToCallPGmain = true
                return initdb_stdout_fd
              } else {
                throw `Unexpected popen mode value ${smode}`
              }
            }
          }, 'ppi')

          mod._pgl_set_popen_fn(popen_fn)

          pclose_fn = mod.addFunction((stream) => {
            if (stream === initdb_stdin_fd || stream === initdb_stdout_fd) {
              // if the last popen had mode w, execute now postgres' main()
              if (needToCallPGmain) {
                needToCallPGmain = false
                pgMainResult = callPgMain(postgresArgs)
              }
              return pgMainResult
            } else {
              return mod._pclose(stream)
            }
          }, 'pi')

          mod._pgl_set_pclose_fn(pclose_fn)

          {
            const pglite_stdin_path = pg.Module.stringToUTF8OnStack(pgstdinPath)
            const rmode = pg.Module.stringToUTF8OnStack('r')
            pg.Module._pgl_freopen(pglite_stdin_path, rmode, 0)
            const pglite_stdout_path =
              pg.Module.stringToUTF8OnStack(pgstdoutPath)
            const wmode = pg.Module.stringToUTF8OnStack('w')
            pg.Module._pgl_freopen(pglite_stdout_path, wmode, 1)
          }

          {
            const initdb_path = mod.stringToUTF8OnStack(pgstdoutPath)
            const rmode = mod.stringToUTF8OnStack('r')
            initdb_stdin_fd = mod._fopen(initdb_path, rmode)

            const path = mod.stringToUTF8OnStack(pgstdinPath)
            const wmode = mod.stringToUTF8OnStack('w')
            initdb_stdout_fd = mod._fopen(path, wmode)
          }
        }
      },
      (mod) => {
        mod.FS.mkdirTree(PG_ROOT)
        mod.FS.mount(
          mod.PROXYFS,
          {
            root: PG_ROOT,
            fs: pg.Module.FS,
          },
          PG_ROOT,
        )
      },
    ],
  }

  const initDbMod = await InitdbModFactory(emscriptenOpts)

  log(debug, 'calling initdb.main with', args)
  const result = initDbMod.callMain(args)

  return {
    exitCode: result,
    stderr: stderrOutput,
    stdout: stdoutOutput,
    dataFolder: PGDATA,
  }
}

/**
 * Execute initdb
 */
export async function initdb({ pg, debug, args, wasmModule }) {
  return await execInitdb({
    pg,
    debug,
    args: [
      '--allow-group-access',
      '--encoding',
      'UTF8',
      '--locale=C.UTF-8',
      '--locale-provider=libc',
      '--auth=trust',
      ...(args ?? []),
    ],
    wasmModule,
  })
}
