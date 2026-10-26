// Port of pglite-react/src/hooks.ts
import { useEffect, useRef, useState } from 'react'
import { query as buildQuery } from '../src/template.js'
import { usePGlite } from './provider.js'

function paramsEqual(a1, a2) {
  if (!a1 && !a2) return true
  if (a1?.length !== a2?.length) return false
  for (let i = 0; i < a1.length; i++) {
    if (!Object.is(a1[i], a2[i])) {
      return false
    }
  }
  return true
}

function useLiveQueryImpl(query, params, key) {
  const db = usePGlite()
  const paramsRef = useRef(params)
  const liveQueryRef = useRef(undefined)
  let liveQuery
  let liveQueryChanged = false
  if (!(typeof query === 'string') && !(query instanceof Promise)) {
    liveQuery = query
    liveQueryChanged = liveQueryRef.current !== liveQuery
    liveQueryRef.current = liveQuery
  }
  const [results, setResults] = useState(liveQuery?.initialResults)

  let currentParams = paramsRef.current
  if (!paramsEqual(paramsRef.current, params)) {
    paramsRef.current = params
    currentParams = params
  }

  useEffect(() => {
    let cancelled = false
    const cb = (results) => {
      if (cancelled) return
      setResults(results)
    }
    if (typeof query === 'string') {
      const ret =
        key !== undefined
          ? db.live.incrementalQuery(query, currentParams, key, cb)
          : db.live.query(query, currentParams, cb)

      return () => {
        cancelled = true
        ret.then(({ unsubscribe }) => unsubscribe())
      }
    } else if (query instanceof Promise) {
      query.then((liveQuery) => {
        if (cancelled) return
        liveQueryRef.current = liveQuery
        setResults(liveQuery.initialResults)
        liveQuery.subscribe(cb)
      })
      return () => {
        cancelled = true
        liveQueryRef.current?.unsubscribe(cb)
      }
    } else if (liveQuery) {
      setResults(liveQuery.initialResults)
      liveQuery.subscribe(cb)
      return () => {
        cancelled = true
        liveQuery.unsubscribe(cb)
      }
    } else {
      throw new Error('Should never happen')
    }
  }, [db, key, query, currentParams, liveQuery])

  if (liveQueryChanged && liveQuery) {
    return liveQuery.initialResults
  }

  return (
    results && {
      rows: results.rows,
      fields: results.fields,
      totalCount: results.totalCount,
      offset: results.offset,
      limit: results.limit,
    }
  )
}

export function useLiveQuery(query, params) {
  return useLiveQueryImpl(query, params)
}

useLiveQuery.sql = function (strings, ...values) {
  const { query, params } = buildQuery(strings, ...values)
  return useLiveQueryImpl(query, params)
}

export function useLiveIncrementalQuery(query, params, key) {
  return useLiveQueryImpl(query, params, key)
}
