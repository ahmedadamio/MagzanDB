// Port of pglite-vue/src/hooks.ts
import {
  watch,
  readonly,
  shallowReactive,
  toRefs,
  shallowRef,
  onScopeDispose,
  ref,
  isRef,
  unref,
} from 'vue'
import { query as buildQuery } from '../src/template.js'
import { injectPGlite } from './dependency-injection.js'

function useLiveQueryImpl(query, params, key) {
  const db = injectPGlite()

  const liveUpdate = shallowReactive({
    rows: undefined,
    fields: undefined,
    blob: undefined,
  })

  // keep track of live query subscriptions to unsubscribe when scope is disposed
  const unsubscribeRef = shallowRef()

  const querySource = typeof query === 'string' ? ref(query) : query
  const paramsSources = !params
    ? []
    : Array.isArray(params)
      ? params.map(ref)
      : [ref(params)]

  const keySource = typeof key === 'string' ? ref(key) : key

  watch(
    key !== undefined
      ? [querySource, keySource, ...paramsSources]
      : [querySource, ...paramsSources],
    () => {
      let cancelled = false
      const cb = (results) => {
        if (cancelled) return
        liveUpdate.rows = results.rows
        liveUpdate.fields = results.fields
        if (results.blob !== undefined) {
          liveUpdate.blob = results.blob
        }
      }

      const q = isRef(querySource) ? unref(querySource) : querySource()

      const paramVals = Array.isArray(params)
        ? params.map((p) => (typeof p === 'function' ? p() : unref(p)))
        : typeof params === 'function'
          ? params()
          : unref(params)

      const k = isRef(keySource) ? keySource.value : keySource?.()

      const ret =
        k !== undefined
          ? db.live.incrementalQuery(q, paramVals, k, cb)
          : db.live.query(q, paramVals, cb)

      unsubscribeRef.value = () => {
        cancelled = true
        return ret.then(({ unsubscribe }) => unsubscribe())
      }
    },
    { immediate: true },
  )

  onScopeDispose(() => unsubscribeRef.value?.())

  return toRefs(readonly(liveUpdate))
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
