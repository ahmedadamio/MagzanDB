// Port of pglite-repl/src/ReplTable.tsx
import { useState, useEffect, createElement as h, Fragment } from 'react'

const tableRowIncrement = 100
const maxCellLength = 200

function cellClass(value) {
  if (value === null) {
    return 'PGliteRepl-null'
  } else if (typeof value === 'number') {
    return 'PGliteRepl-number'
  } else if (typeof value === 'boolean') {
    return 'PGliteRepl-boolean'
  } else {
    return ''
  }
}

function cellValue(value) {
  let str
  if (value === null) {
    str = 'null'
  } else if (typeof value === 'number') {
    str = value.toString()
  } else if (typeof value === 'boolean') {
    str = value ? 'true' : 'false'
  } else if (value instanceof Date) {
    str = value.toISOString()
  } else if (Array.isArray(value)) {
    str = `[${value.map(cellValue).join(', ')}]`
  } else if (typeof value === 'object') {
    str = JSON.stringify(value)
  } else if (ArrayBuffer.isView(value)) {
    str = `${value.byteLength} bytes`
  } else if (value === undefined) {
    str = 'undefined'
  } else {
    str = value.toString()
  }
  return str.length > maxCellLength ? str.slice(0, maxCellLength) + '…' : str
}

export function ReplTable({ result }) {
  const [maxRows, setMaxRows] = useState(tableRowIncrement)
  const rows = result.rows.slice(0, maxRows)

  useEffect(() => {
    // Reset maxRows when the result changes
    setMaxRows(tableRowIncrement)
  }, [result])

  const showMore = () => {
    setMaxRows((prev) => prev + tableRowIncrement)
  }

  return h(
    Fragment,
    null,
    h(
      'div',
      { className: 'PGliteRepl-table-scroll' },
      h(
        'table',
        { className: 'PGliteRepl-table' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            result.fields.map((col) => h('th', { key: col.name }, col.name)),
          ),
        ),
        h(
          'tbody',
          null,
          rows.map((row, i) =>
            h(
              'tr',
              { key: i },
              row.map((col, j) =>
                h('td', { key: j, className: cellClass(col) }, cellValue(col)),
              ),
            ),
          ),
        ),
      ),
    ),
    h(
      'div',
      { className: 'PGliteRepl-table-row-count' },
      `${result.rows.length > maxRows ? `${maxRows} of ` : ''}${result.rows.length} rows `,
      result.rows.length > maxRows &&
        h(
          'a',
          {
            href: '',
            onClick: (e) => {
              e.preventDefault()
              showMore()
            },
          },
          'Show more',
        ),
    ),
  )
}
