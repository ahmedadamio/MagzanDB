// REPL browser driver: serves the adapter, loads repl.html, drives the
// CodeMirror input with real key events and asserts on the rendered DOM.
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { serve } from './serve.mjs'

const ADAPTER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CHROMIUM_CANDIDATES = [
  path.join(
    os.homedir(),
    'Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell',
  ),
  path.join(
    os.homedir(),
    'Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
  ),
]

const results = []
const check = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra: String(extra) })
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`)
}

const { server, port } = await serve(ADAPTER)
console.log(`serving ${ADAPTER} on :${port}`)

let browser
for (const exe of CHROMIUM_CANDIDATES) {
  try {
    browser = await chromium.launch({ executablePath: exe, headless: true })
    console.log('launched:', exe)
    break
  } catch (e) {
    console.log('launch failed:', exe, e.message.split('\n')[0])
  }
}
if (!browser) throw new Error('no chromium binary worked')

const page = await browser.newPage()
page.on('console', (msg) => console.log('[page]', msg.text()))
page.on('pageerror', (err) => console.log('[pageerror]', err.message))

await page.goto(`http://127.0.0.1:${port}/test/browser/repl.html`)
await page.waitForFunction(() => window.__READY, null, { timeout: 120_000 })
// Wait for the CodeMirror editor to mount and the Repl to finish loading
await page.waitForSelector('.PGliteRepl-root', { timeout: 30_000 })
await page.waitForFunction(
  () => !document.querySelector('.PGliteRepl-loading-msg'),
  null,
  { timeout: 30_000 },
)
await page.waitForSelector('#repl-root .cm-content', { timeout: 30_000 })

check('repl mounts', true)

// -- type and run a SELECT ---------------------------------------------
await page.locator('#repl-root .cm-content').click()
await page
  .locator('#repl-root .cm-content')
  .pressSequentially('SELECT v + 1 AS answer FROM repl_items')
await page.keyboard.press('Enter')
await page.waitForSelector('.PGliteRepl-table', { timeout: 30_000 })

const selectOut = await page.evaluate(() => {
  const out = document.querySelector('#repl-root .PGliteRepl-output')
  return {
    table: !!out.querySelector('.PGliteRepl-table'),
    text: out.textContent,
    time: !!out.querySelector('.PGliteRepl-time'),
  }
})
check(
  'repl: select renders table',
  selectOut.table && selectOut.text.includes('answer') && selectOut.text.includes('8'),
  selectOut.text.slice(-120),
)
check('repl: showTime renders elapsed', selectOut.time)

// -- \d describe command via psql-describe -------------------------------
await page.locator('#repl-root .cm-content').click()
await page.locator('#repl-root .cm-content').pressSequentially('\\dt')
await page.keyboard.press('Enter')
await page.waitForFunction(
  () => document.querySelectorAll('#repl-root .PGliteRepl-table').length >= 2 ||
        document.querySelector('#repl-root .PGliteRepl-output').textContent.includes('repl_items'),
  null,
  { timeout: 30_000 },
)
const describeOut = await page.evaluate(
  () => document.querySelector('#repl-root .PGliteRepl-output').textContent,
)
check(
  'repl: \\dt lists tables (psql-describe)',
  describeOut.includes('repl_items'),
  describeOut.slice(-120),
)

// -- error rendering -----------------------------------------------------
await page.locator('#repl-root .cm-content').click()
await page
  .locator('#repl-root .cm-content')
  .pressSequentially('SELECT * FROM no_such_table')
await page.keyboard.press('Enter')
await page.waitForFunction(
  () => document.querySelector('#repl-root .PGliteRepl-output').textContent.includes('no_such_table'),
  null,
  { timeout: 30_000 },
)
const errOut = await page.evaluate(() => ({
  text: document.querySelector('#repl-root .PGliteRepl-output').textContent,
  errEl: !!document.querySelector('#repl-root .PGliteRepl-error'),
}))
check(
  'repl: error renders',
  errOut.errEl && errOut.text.includes('does not exist'),
  errOut.text.slice(-150),
)

// -- webcomponent ---------------------------------------------------------
await page.waitForSelector('pglite-repl', { timeout: 30_000 })
const wcOk = await page.evaluate(async () => {
  const el = document.querySelector('pglite-repl')
  const root = el.shadowRoot.querySelector('.PGliteRepl-root')
  // wait for the shadow editor to mount
  for (let i = 0; i < 100 && !root?.querySelector('.cm-content'); i++) {
    await new Promise((r) => setTimeout(r, 100))
  }
  return (
    !!customElements.get('pglite-repl') &&
    !!el.shadowRoot.querySelector('style') &&
    !!root?.querySelector('.cm-content')
  )
})
check('repl: webcomponent mounts shadow editor', wcOk)

const failed = results.filter((r) => !r.pass).length
console.log(`\n${results.length - failed}/${results.length} passed`)

await browser.close()
server.close()
process.exit(failed ? 1 : 0)
