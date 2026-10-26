# Rust port architecture

Baseline source: `../pglite` (electric-sql/pglite fork)
- repository revision: `e752dbe` ("fix: run initdb with TZ=UTC like the backend (#1156)")
- `postgres-pglite` submodule revision: `29b6424aa312ec3556247db069939006dd27f878` (not initialized locally)
- package version: `@electric-sql/pglite@0.5.11`

Engine artifacts: taken from the published npm tarball
`@electric-sql/pglite@0.5.11` (`vendor/package/dist/`), which ships the same
`release/` outputs the repo's `wasm:copy-*` scripts copy out of the submodule
build: `pglite.js` (Emscripten factory), `pglite.wasm`, `pglite.data`,
`initdb.js`, `initdb.wasm`. These were also staged into
`../pglite/packages/pglite/release/` so the reference test suite can run.

## Target architecture

```text
JS caller
   │
   ▼
adapter/ (TypeScript/JS, host) ────────────┐
   │ public API surface, JS values,        │
   │ Emscripten module lifecycle, FS,      │
   │ workers, IndexedDB/OPFS/NodeFS        │
   ▼                                       │
pglite-bridge (wasm32 cdylib) ◄── host_* imports
   │ raw (ptr,len) ABI + tagged-JSON value envelope
   ▼
pglite-core   pglite-protocol (pure Rust, JS-free)
   │
   ▼ via host_exec_sync import
Emscripten pglite.wasm (postgres engine, unchanged)
```

### Why a separate Wasm module + synchronous host imports

The Emscripten engine cannot share linear memory, pointers, allocators, or
function tables with a Rust Wasm module (guide §3). All engine entry points
(`callMain`, `_PostgresMainLoopOnce`, `_pgl_pq_flush`, …) are *synchronous*
JS function calls in the reference, and the socket read/write callbacks fire
synchronously while the engine loop runs. Therefore the boundary is:

- Rust → JS: `host_exec_sync(in_ptr, in_len) -> u64` — the JS adapter runs the
  equivalent of `execProtocolRawSync`: feeds `in` bytes to the engine read
  callback, drives `_PostgresMainLoopOnce` until the input is consumed,
  translates `ExitStatus(100)` (`POSTGRES_MAIN_LONGJMP`) into
  `_PostgresMainLongJmp()`, then calls
  `_PostgresSendReadyForQueryIfNecessary` + `_pgl_pq_flush`. Response bytes are
  copied into Rust linear memory via `pgl_alloc` and returned as a packed
  `(ptr << 32) | len`.
- JS → Rust: `pgl_call(session, op, ptr, len) -> u64` entry point dispatching
  on `op` (`query`, `exec`, `describe`, …). Buffers are allocated with
  `pgl_alloc` and released with `pgl_free`.
- Values cross as a tagged-JSON envelope (`adapter/src/values.js` ⇄
  `pglite-core`'s `Value`). Tags preserve JS types that JSON cannot:
  `$bigint` (arbitrary precision via decimal string), `$bytes` (hex,
  → `Uint8Array`), `$date` (→ `new Date(str)` so JS `Date.parse` semantics are
  retained verbatim — deliberately kept host-side), plain JSON otherwise.
- Async work (initdb, FS sync, IndexedDB, file loading) stays in the adapter.
  Rust futures/executors are not introduced.

### Engine boundary invariants

- `host_exec_sync` never retains a view into Emscripten `HEAPU8` across calls:
  each engine→JS write callback copies `HEAPU8.subarray(ptr, len)` into a fresh
  `Uint8Array` before it is passed along.
- Rust never interprets an Emscripten heap offset as a Rust pointer; every byte
  crosses by explicit copy through `pgl_alloc`.
- `addFunction` callbacks registered on the engine module are released exactly
  once with `removeFunction` on close (mirroring `pglite.ts` `#onRuntimeInitialized`/`close`).
- `POSTGRES_MAIN_LONGJMP = 100`, `PGLITE_EXIT_ALIVE = 99` — kept in sync with
  `pglitec.c` via the reference source.

## Crates

| crate | role | source modules |
|---|---|---|
| `pglite-protocol` | byte-level wire protocol: reader, writer, serializer, incremental parser, message types | `packages/pg-protocol/src/*` |
| `pglite-core` | value codecs (types.ts), result assembly (parse.ts), errors (errors.ts), templating (templating.ts), query orchestration + transaction state (base.ts) | `packages/pglite/src/{types,parse,errors,templating,base}.ts` |
| `pglite-bridge` | wasm32 cdylib: raw ABI, session handles, host imports; the only crate that knows about JS | engine boundary |

`pglite-protocol` and `pglite-core` compile for both `wasm32-unknown-unknown`
and host targets so `cargo test` runs natively. Only `pglite-bridge` is
wasm-only.

## Adapter (retained host layer)

`adapter/` is plain ESM JS, dependency-free. It owns what the module map
assigns to the host: Emscripten factory invocation, `instantiateWasm`,
`getPreloadedPackage`, `ENV`/`preRun` hooks, `/dev/blob`, the socket
read/write callbacks, the `initdb` second-module flow (PROXYFS mount onto a
scratch postgres module + tarball transfer), tar read/write, filesystem
policy, and value materialization (`new Date`, `Uint8Array`, `BigInt`).

## Toolchain

- rustc 1.99.1, target `wasm32-unknown-unknown` (std, no WASI)
- No wasm-bindgen for now: the ABI is bytes-only by design so
  `pglite-protocol`/`pglite-core` stay host-agnostic and copy-explicit.
  A wasm-bindgen facade can be added later for the public JS API surface
  without touching the core crates. TODO(port): revisit when the public API
  needs rich JS values directly.
- Node ≥ 20 for the adapter/tests (`node:test`, `fs/promises`).

## Verification matrix (current)

- `cargo test` (native): protocol unit + golden tests.
- `node --test tests/`: adapter-level differential tests against the vendor
  Emscripten engine in Node.
- Baseline reference suite: `pnpm install` + `pnpm --filter "pglite^..." build`
  + vitest in `../pglite` with vendored `release/` artifacts.
- Browser (Chromium/Firefox/WebKit), Bun, Deno: **blocked** — not yet wired;
  must not be reported as passing.
