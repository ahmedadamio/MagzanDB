// Port of pglite-vue/src/dependency-injection.ts
import { provide, inject, unref } from 'vue'

const PGliteKey = Symbol('PGliteProvider')

/**
 * Get a PGlite provider and injector for a Vue application.
 * Returns `{ providePGlite, injectPGlite }`.
 */
function makePGliteDependencyInjector() {
  const providePGlite = (db) => provide(PGliteKey, db)

  const injectPGlite = () => {
    const db = inject(PGliteKey)
    return unref(db)
  }

  return {
    providePGlite,
    injectPGlite,
  }
}

const { injectPGlite, providePGlite } = makePGliteDependencyInjector()

export { makePGliteDependencyInjector, injectPGlite, providePGlite }
