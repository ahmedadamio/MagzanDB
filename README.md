# MagzanDB

Embedded PostgreSQL 18.6 (compiled to WebAssembly) with a Rust protocol/session
core and a JavaScript adapter implementing the full PGlite API surface.

A Rust-workspace port of [electric-sql/pglite](https://github.com/electric-sql/pglite):
the engine is the same upstream Postgres wasm build; protocol parsing, session
management and type codecs live in Rust (`crates/`), and the public API
(`PGlite`, workers, live queries, sync, extensions, socket server, pg-compat,
tools, REPL, React/Vue bindings) is implemented in `adapter/` — a drop-in,
self-contained package (ESM + CJS + type declarations).

## Layout

- `crates/pglite-protocol` — Postgres wire-protocol codec and message model (Rust)
- `crates/pglite-core` — session/query orchestration over the wasm engine (Rust)
- `crates/pglite-bridge` — wasm-bindgen bridge consumed by the adapter
- `adapter/` — the PGlite-compatible package (`@pglite-rust/adapter`)
  - `src/` — API surface: pglite, fs (NodeFS/MemoryFS/IdbFs/OPFS-AHP), worker,
    live, sync (pluggable providers, Electric included), socket, pg-compat,
    tools (pg_dump), icu, prepopulatedfs, contrib + extension modules
  - `react/`, `vue/`, `repl/` — framework integrations and SQL REPL
  - `release/` — engine wasm + `initdb` + extension tarballs (built artifacts)
  - `types/` — `.d.ts` / `.d.cts` declarations
  - `test/` — Node/Bun/Deno/Chromium suites incl. the differential harness
- `docs/rust-port/` — architecture notes and port status
- `scripts/build-bridge.sh` — rebuild the wasm-bindgen bridge into `adapter/dist`

## Quickstart

```js
import { PGlite } from '@pglite-rust/adapter'

const db = await PGlite.create()
const { rows } = await db.query('SELECT 1 AS one')
await db.close()
```

Persistence: `PGlite.create('pgdata://./mydb')` (NodeFS) or `idb://`, `opfs-ahp://`
in the browser. Workers: `PGliteWorker.create(new Worker(...))`. Sync:
`import { sync, electricSync } from '@pglite-rust/adapter/sync'`.

## Development

```sh
npm --prefix adapter install
npm --prefix adapter run build:cjs    # CommonJS output (dist-cjs/)
npm --prefix adapter test             # full suite (Node + Chromium)
cargo test --workspace                # Rust tests
./scripts/build-bridge.sh             # rebuild Rust bridge → adapter/dist
```

The differential suite (`adapter/test/diff.mjs`) compares against a sibling
checkout of the upstream TS repo (`../pglite`); it skips cleanly when absent.

## Status

Feature-complete port — see `docs/rust-port/status.md` for the per-surface
verification table. One deferred item: live Electric wire-protocol sync is
implemented behind the pluggable provider API but not verified against a
running Electric server.
