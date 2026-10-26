// Port of pglite-repl/src/Repl.tsx
import {
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
  createElement as h,
} from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { defaultKeymap } from '@codemirror/commands'
import { keymap } from '@codemirror/view'
import { PostgreSQL } from '@codemirror/lang-sql'
import { usePGlite } from '../react/index.js'
import { makeSqlExt } from './sqlSupport.js'
import { runQuery, getSchema } from './utils.js'
import { ReplResponse } from './ReplResponse.js'
import {
  githubDark,
  githubDarkInit,
  githubLight,
  githubLightInit,
} from '@uiw/codemirror-theme-github'

// Filter out the Enter key from the default keymap, we entirely override its behavior
// to run the query when the user presses Enter.
// We keep the up and down arrow keys as we only override their behavior
// when the cursor is on the first or last line.
const baseKeymap = defaultKeymap.filter((key) => key.key !== 'Enter')

export const defaultLightThemeInit = githubLightInit
export const defaultLightTheme = githubLight
export const defaultDarkThemeInit = githubDarkInit
export const defaultDarkTheme = githubDark

export function Repl({
  pg: pgProp,
  border = false,
  lightTheme = defaultLightTheme,
  darkTheme = defaultDarkTheme,
  theme = 'auto',
  showTime = false,
  disableUpdateSchema = false,
}) {
  const [value, setValue] = useState('')
  const valueNoHistory = useRef('')
  const [loading, setLoading] = useState(true)
  const [output, setOutput] = useState([])
  const outputRef = useRef(null)
  const [schema, setSchema] = useState({})
  const historyPos = useRef(-1)
  const rcm = useRef(null)
  const [themeToUse, setThemeToUse] = useState(
    theme === 'dark' ? darkTheme : lightTheme,
  )
  const [styles, setStyles] = useState({})

  const pg = usePGlite(pgProp)

  useEffect(() => {
    let ignore = false
    const init = async () => {
      await pg.waitReady
      if (ignore) return
      setLoading(false)
    }
    setLoading(true)
    init()
    return () => {
      ignore = true
    }
  }, [pg])

  useEffect(() => {
    if (theme === 'auto') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
        .matches
        ? 'dark'
        : 'light'
      setThemeToUse(systemTheme === 'dark' ? darkTheme : lightTheme)
      const listener = (e) => {
        setThemeToUse(e.matches ? darkTheme : lightTheme)
        setTimeout(() => {
          extractStyles()
        }, 0)
      }
      window
        .matchMedia('(prefers-color-scheme: dark)')
        .addEventListener('change', listener)
      return () => {
        window
          .matchMedia('(prefers-color-scheme: dark)')
          .removeEventListener('change', listener)
      }
    } else {
      setThemeToUse(theme === 'dark' ? darkTheme : lightTheme)
      setTimeout(() => {
        extractStyles()
      }, 0)
      return
    }
  }, [theme, lightTheme, darkTheme])

  const onChange = useCallback((val, _viewUpdate) => {
    extractStyles()
    setValue(val)
    if (historyPos.current === -1) {
      valueNoHistory.current = val
    }
  }, [])

  const extensions = useMemo(
    () => [
      keymap.of([
        {
          key: 'Enter',
          preventDefault: true,
          run: () => {
            if (value.trim() === '') return false // Do nothing if the input is empty
            runQuery(value, pg).then((response) => {
              setOutput((prev) => [...prev, response])
              if (outputRef.current) {
                setTimeout(() => {
                  outputRef.current.scrollTop = outputRef.current.scrollHeight
                }, 0)
              }
              // Update the schema for any new tables to be used in autocompletion
              if (!disableUpdateSchema) {
                getSchema(pg).then(setSchema)
              }
            })
            historyPos.current = -1
            valueNoHistory.current = ''
            setValue('')
            return true
          },
        },
        {
          key: 'ArrowUp',
          run: (view) => {
            const state = view.state
            const cursorLine = state.doc.lineAt(state.selection.main.head).number
            if (cursorLine === 1) {
              // If the cursor is on the first line, go back in history
              const currentPos = historyPos.current
              historyPos.current++
              if (historyPos.current >= output.length) {
                historyPos.current = output.length - 1
              }
              if (historyPos.current < -1) {
                historyPos.current = -1
              }
              if (historyPos.current === currentPos) return true
              if (historyPos.current === -1) {
                setValue(valueNoHistory.current)
              } else {
                setValue(output[output.length - historyPos.current - 1].query)
              }
              return true // Prevent the default behavior
            }
            return false // Allow the default behavior
          },
        },
        {
          key: 'ArrowDown',
          run: (view) => {
            const state = view.state
            const cursorLine = state.doc.lineAt(state.selection.main.head).number
            const lastLine = state.doc.lines
            if (cursorLine === lastLine) {
              // If the cursor is on the last line, go forward in history
              const currentPos = historyPos.current
              historyPos.current--
              if (historyPos.current >= output.length) {
                historyPos.current = output.length - 1
              }
              if (historyPos.current < -1) {
                historyPos.current = -1
              }
              if (historyPos.current === currentPos) return true
              if (historyPos.current === -1) {
                setValue(valueNoHistory.current)
              } else {
                setValue(output[output.length - historyPos.current - 1].query)
              }
              return true // Prevent the default behavior
            }
            return false // Allow the default behavior
          },
        },
        ...baseKeymap,
      ]),
      makeSqlExt({
        dialect: PostgreSQL,
        schema: schema,
        tables: [
          {
            label: 'd',
            displayLabel: '\\d',
          },
        ],
        defaultSchema: 'public',
      }),
    ],
    [pg, schema, value, output, disableUpdateSchema],
  )

  const extractStyles = () => {
    // Get the styles from the CodeMirror editor to use in the REPL
    const cmEditorEl = rcm.current?.editor?.querySelector('.cm-editor')
    if (!cmEditorEl) {
      return
    }
    const gutterEl = cmEditorEl.querySelector('.cm-gutters')
    const cmEditorElComputedStyles = window.getComputedStyle(cmEditorEl)
    const foregroundColor = cmEditorElComputedStyles.color
    const backgroundColor = cmEditorElComputedStyles.backgroundColor

    const gutterElComputedStyles = window.getComputedStyle(gutterEl)
    const gutterBorder = gutterElComputedStyles.borderRight
    const borderWidth = parseInt(gutterElComputedStyles.borderRightWidth) || 0
    const borderColor = borderWidth
      ? gutterElComputedStyles.borderRightColor
      : foregroundColor.replace('rgb', 'rgba').replace(')', ', 0.15)')
    const border = borderWidth
      ? gutterElComputedStyles.borderRight
      : `1px solid ${borderColor}`

    setStyles({
      '--PGliteRepl-foreground-color': foregroundColor,
      '--PGliteRepl-background-color': backgroundColor,
      '--PGliteRepl-border': border,
      '--PGliteRepl-gutter-border': gutterBorder,
      '--PGliteRepl-border-color': borderColor,
    })
  }

  return h(
    'div',
    {
      className: `PGliteRepl-root ${border ? 'PGliteRepl-root-border' : ''}`,
      style: styles,
    },
    h(
      'div',
      { className: 'PGliteRepl-output', ref: outputRef },
      loading && h('div', { className: 'PGliteRepl-loading-msg' }, 'Loading...'),
      output.map((response) =>
        h(
          'div',
          { key: `${response.query}-${response.time}` },
          h(ReplResponse, { response: response || [], showTime }),
        ),
      ),
    ),
    h(CodeMirror, {
      ref: rcm,
      className: `PGliteRepl-input ${loading ? 'PGliteRepl-input-loading' : ''}`,
      width: '100%',
      value: value,
      basicSetup: {
        defaultKeymap: false,
      },
      extensions: extensions,
      theme: themeToUse,
      onChange: onChange,
      editable: !loading,
      onCreateEditor: () => {
        extractStyles()
        setTimeout(extractStyles, 0)
        getSchema(pg).then(setSchema)
      },
    }),
  )
}
