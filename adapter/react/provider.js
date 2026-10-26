// Port of pglite-react/src/provider.tsx
import { createContext, createElement, useContext } from 'react'

/**
 * Create a typed set of `PGliteProvider` and `usePGlite`.
 */
function makePGliteProvider() {
  const ctx = createContext(undefined)
  return {
    usePGlite: (db) => {
      const dbProvided = useContext(ctx)

      // allow providing a db explicitly
      if (db !== undefined) return db

      if (!dbProvided)
        throw new Error(
          'No PGlite instance found, use PGliteProvider to provide one',
        )

      return dbProvided
    },
    PGliteProvider: ({ children, db }) =>
      createElement(ctx.Provider, { value: db }, children),
  }
}

const { PGliteProvider, usePGlite } = makePGliteProvider()

export { makePGliteProvider, PGliteProvider, usePGlite }
