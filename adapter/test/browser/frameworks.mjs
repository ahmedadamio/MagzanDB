// Real React + Vue against a real PGlite in Chromium.
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { createApp, defineComponent, h as vh } from 'vue'
import { PGlite } from '/src/index.js'
import { live } from '/src/live.js'
import { PGliteProvider, useLiveQuery, usePGlite } from '/react/index.js'
import {
  providePGlite,
  useLiveQuery as useVueLiveQuery,
} from '/vue/index.js'

const results = []
const check = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra: String(extra) })
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const text = (id) => document.getElementById(id)?.textContent

try {
  const db = await PGlite.create('', { extensions: { live } })
  await db.exec('CREATE TABLE items (id serial primary key, v int)')

  // ---------- React ----------
  function RowList() {
    const res = useLiveQuery('SELECT * FROM items ORDER BY id')
    return h(
      'div',
      { id: 'react-out' },
      res === undefined ? 'loading' : res.rows.map((r) => r.v).join(','),
    )
  }
  function DbVersion() {
    const d = usePGlite()
    return h('div', { id: 'react-db' }, d === db ? 'ctx-ok' : 'ctx-missing')
  }
  const root = createRoot(document.getElementById('react-root'))
  root.render(
    h(PGliteProvider, { db }, h(RowList), h(DbVersion)),
  )
  await wait(600)
  check('react: ctx provides db', text('react-db') === 'ctx-ok', text('react-db'))
  check('react: initial empty', text('react-out') === '', text('react-out'))
  await db.query('INSERT INTO items (v) VALUES (11)')
  await wait(800)
  check('react: live insert', text('react-out') === '11', text('react-out'))
  await db.query('INSERT INTO items (v) VALUES (22)')
  await wait(800)
  check('react: live second row', text('react-out') === '11,22', text('react-out'))

  // ---------- Vue ----------
  const VueChild = defineComponent({
    setup() {
      const { rows } = useVueLiveQuery('SELECT * FROM items ORDER BY id')
      return () =>
        vh(
          'div',
          { id: 'vue-out' },
          rows.value === undefined
            ? 'loading'
            : rows.value.map((r) => r.v).join(','),
        )
    },
  })
  const VueApp = defineComponent({
    setup() {
      providePGlite(db)
      return () => vh(VueChild)
    },
  })
  createApp(VueApp).mount(document.getElementById('vue-root'))
  await wait(600)
  check(
    'vue: initial rows',
    text('vue-out') === '11,22',
    text('vue-out'),
  )
  await db.query('INSERT INTO items (v) VALUES (33)')
  await wait(800)
  check('vue: live insert', text('vue-out') === '11,22,33', text('vue-out'))

  await db.close()
} catch (e) {
  check('frameworks: uncaught', false, e.stack || String(e))
}

const failed = results.filter((r) => !r.pass)
window.__RESULTS = { total: results.length, failed: failed.length, results }
window.__DONE = true
console.log(`FRAMEWORKS-DONE total=${results.length} failed=${failed.length}`)
