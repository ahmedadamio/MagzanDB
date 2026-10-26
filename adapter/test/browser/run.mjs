// Browser harness driver: static server + playwright-core + cached chromium.
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

const pagePath = process.argv[2] || '/test/browser/index.html'

const page = await browser.newPage()
page.on('console', (msg) => console.log('[page]', msg.text()))
page.on('pageerror', (err) => console.log('[pageerror]', err.message))

await page.goto(`http://127.0.0.1:${port}${pagePath}`)
await page.waitForFunction(() => window.__DONE, null, { timeout: 180_000 })

const results = await page.evaluate(() => window.__RESULTS)
for (const r of results.results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.name} ${r.extra || ''}`)
}
console.log(`\n${results.total - results.failed}/${results.total} passed`)

await browser.close()
server.close()
process.exit(results.failed ? 1 : 0)
