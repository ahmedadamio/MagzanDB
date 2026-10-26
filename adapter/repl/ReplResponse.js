// Port of pglite-repl/src/ReplResponse.tsx
import { createElement as h, Fragment } from 'react'
import { ReplTable } from './ReplTable.js'

function OutLine({ result }) {
  return h(
    'div',
    { className: 'PGliteRepl-line' },
    result.fields.length > 0
      ? h(ReplTable, { result })
      : h('div', { className: 'PGliteRepl-null' }, 'null'),
  )
}

export function ReplResponse({ response, showTime }) {
  let out
  if (response.error) {
    out = h(
      'div',
      { className: 'PGliteRepl-line PGliteRepl-error' },
      response.error,
    )
  } else {
    out = h(
      Fragment,
      null,
      response.results?.map((result, i) => h(OutLine, { key: i, result })),
    )
  }
  return h(
    Fragment,
    null,
    h('pre', { className: 'PGliteRepl-line PGliteRepl-query' }, response.query),
    response.text &&
      h('div', { className: 'PGliteRepl-line PGliteRepl-text' }, response.text),
    out,
    h(
      'div',
      { className: 'PGliteRepl-divider' },
      h('hr'),
      showTime &&
        h('div', { className: 'PGliteRepl-time' }, `${response.time.toFixed(1)}ms`),
    ),
  )
}
