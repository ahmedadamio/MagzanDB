// Build CJS output for every package export — mirrors upstream's dual
// ESM+CJS surface. Layout:
//   dist-cjs/_runtime.cjs  — one esbuild bundle exposing every node-safe
//                            submodule as a namespace (react/vue excluded:
//                            they statically import optional peers)
//   dist-cjs/<sub>.cjs     — thin stubs re-exporting a runtime namespace
//   dist-cjs/{react,vue}.cjs — individually bundled (react/vue externals
//                            are only required when these are loaded)
//   dist-cjs/repl{,-webcomponent}.cjs — individually bundled for the same
//                            reason (codemirror/react externals)
import { build } from 'esbuild'
import {
  mkdirSync,
  readdirSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'dist-cjs')
mkdirSync(path.join(OUT, 'contrib'), { recursive: true })
mkdirSync(path.join(OUT, 'ext'), { recursive: true })

const common = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  define: { 'import.meta.url': '__CJS_MODULE_URL__' },
  loader: { '.css': 'empty' },
  banner: {
    js: 'const __CJS_MODULE_URL__ = require("url").pathToFileURL(__filename).href;',
  },
  external: [
    'react',
    'react-dom',
    'react-dom/*',
    'vue',
    'vue-demi',
    '@uiw/*',
    '@codemirror/*',
    'codemirror',
    'psql-describe',
    '@electric-sql/client',
    '@electric-sql/experimental',
  ],
  logLevel: 'warning',
}

await build({
  ...common,
  entryPoints: [path.join(ROOT, 'src/cjs-runtime.js')],
  outfile: path.join(OUT, '_runtime.cjs'),
})
await Promise.all(
  ['react/index.js', 'vue/index.js'].map((src) =>
    build({
      ...common,
      entryPoints: [path.join(ROOT, src)],
      outfile: path.join(OUT, src.replace('/index.js', '.cjs')),
    }),
  ),
)
await Promise.all(
  [
    ['repl/index.js', 'repl.cjs'],
    ['repl/webcomponent.js', 'repl-webcomponent.cjs'],
  ].map(([src, out]) =>
    build({
      ...common,
      entryPoints: [path.join(ROOT, src)],
      outfile: path.join(OUT, out),
    }),
  ),
)

// subpath export name -> runtime namespace / stub body
const stubs = {
  'index.cjs': 'index',
  'template.cjs': 'template',
  'live.cjs': 'live',
  'worker.cjs': 'worker',
  'nodefs.cjs': 'nodefs',
  'basefs.cjs': 'basefs',
  'opfs-ahp.cjs': 'opfs_ahp',
  'socket.cjs': 'socket',
  'pg-compat.cjs': 'pg_compat',
  'sync.cjs': 'sync',
  'sync-apply.cjs': 'sync_apply',
  'tools.cjs': 'tools',
  'icu.cjs': 'icu',
  'prepopulatedfs.cjs': 'prepopulatedfs',
}
for (const f of readdirSync(path.join(ROOT, 'contrib')))
  if (f.endsWith('.js'))
    stubs[`contrib/${f.replace(/\.js$/, '.cjs')}`] = `contrib_${f.slice(0, -3)}`
for (const f of readdirSync(path.join(ROOT, 'ext')))
  if (f.endsWith('.js'))
    stubs[`ext/${f.replace(/\.js$/, '.cjs')}`] = `ext_${f.slice(0, -3)}`

for (const [file, ns] of Object.entries(stubs)) {
  const up = path.dirname(file) === '.' ? './' : '../'
  writeFileSync(
    path.join(OUT, file),
    `module.exports = require('${up}_runtime.cjs').${ns}\n`,
  )
}

// pg_dump.wasm resolves relative to its module URL — the bundled chunk
// lives in _runtime.cjs under dist-cjs/, so the wasm sits beside it.
copyFileSync(
  path.join(ROOT, 'vendor-tools/pg_dump.wasm'),
  path.join(OUT, 'pg_dump.wasm'),
)

console.log(`cjs: _runtime.cjs + ${Object.keys(stubs).length} stubs + react/vue/repl`)
