// Real pglite-repl against a real PGlite in Chromium.
// Bundled with esbuild to vendor/repl-app.mjs (react/codemirror dep tree).
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { PGlite } from '../../src/index.js'
import { Repl } from '../../repl/index.js'
import { PGliteProvider } from '../../react/index.js'
import '../../repl/webcomponent.js'

const db = await PGlite.create('memory://')
await db.exec('CREATE TABLE repl_items (id serial primary key, v int)')
await db.query("INSERT INTO repl_items (v) VALUES (7)")

const root = createRoot(document.getElementById('repl-root'))
root.render(
  h(PGliteProvider, { db }, h(Repl, { theme: 'light', showTime: true })),
)

// Mount the webcomponent with the same db
const wc = document.createElement('pglite-repl')
wc.setAttribute('border', 'true')
wc.pg = db
document.getElementById('wc-root').appendChild(wc)

window.__DB = db
window.__READY = true
console.log('repl app ready')
