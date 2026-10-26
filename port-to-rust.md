The useful parts of the supplied guide are its explicit module map, translation rules, ownership constraints, and verification stages. For PGlite, I’d add an early integration milestone: Rust must work with the existing PostgreSQL/Emscripten engine before attempting a broad translation.

This prompt assumes you want to preserve PGlite’s browser, Node.js, Bun, and Deno support and its JavaScript API.

# PGlite: TypeScript → Rust migration guide

You are migrating PGlite’s TypeScript implementation to Rust. Read this entire document before writing code.

The objective is a working, behaviorally compatible Rust implementation of PGlite’s portable logic, exposed through the existing JavaScript/TypeScript API. Preserve supported environments, database compatibility, extensions, and package entry points.

This is an implementation task. Work incrementally, verify each stage, and maintain an accurate migration record.

## 1. Understand what is being migrated

PGlite combines:

1. PostgreSQL compiled to WebAssembly using Emscripten.
2. TypeScript code implementing database lifecycle, protocol handling, queries, transactions, type conversion, persistence coordination, workers, and extensions.
3. JavaScript runtime integrations and framework packages.

**Migrate the TypeScript implementation. Keep the existing PostgreSQL engine.**

Do not rewrite PostgreSQL in Rust, replace it with another database, introduce a remote PostgreSQL server, or assume its Emscripten Wasm artifacts are interchangeable with WASI modules.

The default architecture is:

- Rust owns portable protocol processing, query orchestration, transaction state, result processing, and other migrated business logic.
- Thin JavaScript/TypeScript adapters preserve the public API and provide host capabilities.
- Existing PostgreSQL Wasm artifacts and generated Emscripten glue remain the engine.
- Framework integrations remain in their host language where appropriate.

A standalone Rust-native database embedding is a separate architectural objective. Do not silently change this migration into that project.

A Rust wrapper that delegates all meaningful work to the old TypeScript implementation is a transitional milestone, not migration completion.

## 2. Establish the source of truth

Before implementation:

- Read applicable repository instructions.
- Record the repository revision and `postgres-pglite` submodule revision.
- Inspect package exports, build scripts, test scripts, and CI.
- Identify available PostgreSQL, initdb, extension, and pg_dump artifacts.
- Establish baseline test results before modifying behavior.
- Record existing failures separately from migration regressions.

Start with:

```text
packages/pglite/src/interface.ts
packages/pglite/src/base.ts
packages/pglite/src/pglite.ts
packages/pglite/src/postgresMod.ts
packages/pglite/src/initdb.ts
packages/pglite/src/initdbModFactory.ts
packages/pglite/src/parse.ts
packages/pglite/src/types.ts
packages/pglite/src/errors.ts
packages/pglite/src/templating.ts
packages/pglite/src/fs/
packages/pglite/src/worker/
packages/pglite/src/live/
packages/pg-protocol/src/
packages/pglite/tests/
.github/workflows/build_and_test.yml
```

Read callers, implementations, and tests together. TypeScript declarations alone do not establish runtime behavior.

Maintain:

```text
docs/rust-port/architecture.md
docs/rust-port/module-map.tsv
docs/rust-port/compatibility.md
docs/rust-port/status.md
```

These are new migration records, not assumed existing files.

For each source module, record its destination, dependencies, retained host responsibilities, verification coverage, and status.

Use these statuses:

```text
not-started
in-progress
implemented
verified
retained-host
blocked
```

“Implemented” means the Rust code exists and compiles. “Verified” means its compatibility checks pass on the relevant targets.

## 3. Prove the engine boundary first

Before translating large modules, implement a small end-to-end integration.

The initial candidate is a Rust Wasm module connected through a narrow JavaScript adapter to the existing Emscripten PostgreSQL module. Validate this design; do not assume it works.

The integration must:

1. Load the existing engine.
2. Initialize an in-memory database.
3. Execute a parameterized query through Rust-owned logic.
4. Return rows and field metadata through the existing JavaScript API shape.
5. Recover from a SQL error and execute another query.
6. Close the database and release bridge resources.
7. Run in Node.js and a browser.

Document:

- Rust compilation target and binding mechanism.
- Synchronous and asynchronous calls in each direction.
- Memory ownership and every cross-module copy.
- Callback registration and lifetime.
- Exception and PostgreSQL control-flow handling.
- Module initialization and asset-loading behavior.
- How the solution preserves ESM and CommonJS entry points.

**Separate Wasm modules do not automatically share memory, pointers, allocators, or function tables.**

An Emscripten heap offset is not a pointer into Rust’s linear memory. Never create a Rust slice from that offset unless the architecture explicitly establishes valid shared memory and its safety invariants.

Use explicit copies initially when ownership is uncertain. Measure their cost later.

If the candidate fails, document the concrete failure and investigate the smallest viable alternative before continuing dependent work. Do not generate hundreds of Rust files around an unproven bridge.

## 4. Module and crate layout

Use a Cargo workspace alongside the existing pnpm workspace.

The following is a proposed responsibility map. Inspect dependencies, resolve cycles, and establish the final map during the architecture stage. Once established, individual porting tasks must follow it.

| Existing source | Proposed Rust destination | Host responsibilities |
|---|---|---|
| `packages/pg-protocol/src/*` | `pglite-protocol` | Compatibility exports where needed |
| `types.ts`, `parse.ts`, `errors.ts` | `pglite-core::{types,results,error}` | JavaScript value and exception conversion |
| `templating.ts` | `pglite-core::templating` | Tagged-template entry points |
| `base.ts` | `pglite-core::{query,transaction}` | Promise and callback boundary |
| `pglite.ts` | `pglite-core::database` plus engine adapter | Emscripten module operations |
| `postgresMod.ts`, `initdbModFactory.ts`, `initdb.ts` | Engine abstraction and `pglite-js` adapter | Generated factories, imports, initialization hooks |
| `fs/*` | Portable filesystem policy and contracts | Emscripten FS, IndexedDB, OPFS, Node APIs |
| `worker/*` | Portable coordination state where practical | Worker, BroadcastChannel, locks, structured cloning |
| `live/*` | `pglite-live` | Subscription callback adapter |
| `extensionUtils.ts`, `contrib/*` | Extension lifecycle and metadata | JavaScript extension hooks and bundle loading |
| `packages/pglite-sync/src/*` | `pglite-sync` for portable application/state logic | Existing Electric client transport adapter |
| Socket, node-postgres, tools packages | Reuse migrated core where applicable | Node interfaces, streams, generated tools |
| React, Vue, REPL packages | Retain framework implementations | Consume the compatible migrated API |

Use ordinary Rust layout:

```text
crates/<crate-name>/Cargo.toml
crates/<crate-name>/src/lib.rs
crates/<crate-name>/src/<module>.rs
```

Do not scatter uncompiled `.rs` files next to every `.ts` file.

Keep the protocol crate independent of JavaScript and database orchestration. Keep host bindings outside portable logic. Avoid creating a crate for every source file.

Do not hide substantial unported business logic under “host adapter.” Document why each retained TypeScript responsibility needs to remain there.

## 5. Ground rules

- Preserve observable behavior before improving implementation.
- Keep the TypeScript reference available during migration.
- Port coherent dependency slices, with compiling checkpoints.
- Preserve recognizable control flow where useful for comparison.
- Use snake_case internally; preserve JavaScript names at the boundary.
- Do not combine migration with unrelated refactoring or bug fixes.
- Record suspected existing bugs and address behavioral changes separately.
- Never weaken tests merely to make the port pass.
- Never report a stub or a TypeScript fallback as migrated functionality.
- Do not hand-edit generated Emscripten glue or generated release artifacts.
- Preserve licenses and source attribution.

Use explicit annotations:

```rust
// TODO(port): unresolved behavior and the evidence needed to resolve it.
// PERF(port): changed allocation, copy, or execution behavior to benchmark.
// PORT NOTE: intentional structural change and why it preserves behavior.
// SAFETY: precise ownership, bounds, lifetime, and reentrancy invariants.
```

An unresolved marker is a tracking mechanism, not permission to ship incomplete required behavior.

Unlike Bun’s supplied guide, this project does not inherit a ban on `async fn`, a specific allocator, or a particular runtime. Choose dependencies according to PGlite’s architecture and target requirements.

## 6. TypeScript → Rust type rules

| TypeScript | Rust guidance |
|---|---|
| `boolean` | `bool` |
| `number` | Choose from semantics: `f64`, checked integer, OID newtype, length, or offset |
| PostgreSQL OID | `u32` or a checked newtype |
| `bigint` | Appropriate integer representation; preserve arbitrary precision where accepted |
| Text `string` | `String` / `&str` after explicit boundary encoding |
| `Uint8Array`, binary `ArrayBuffer` | Owned `Vec<u8>` or borrowed `&[u8]` with proven lifetime |
| `T[]` | `Vec<T>` or slices |
| Discriminated union | Enum with payload variants |
| Interface | Struct for data; trait for a genuine behavioral contract |
| `Promise<T>` | Future; use `Result<T, E>` for failure |
| `Map<K,V>` | Select according to ordering and key semantics |
| `Set<T>` | Preserve iteration order when observable |
| Optional property | `Option<T>` only if missing/null distinctions are irrelevant |
| Callback | Owned closure or registered handle with explicit lifetime |
| `Blob`, `File`, `URL`, `Date` | Host values or explicit domain representations with compatible conversion |
| `any`, `unknown` | Explicit domain enum, generic, trait, or boundary-only host value |

Additional rules:

- Do not turn every JavaScript number into `i64`.
- Check narrowing conversions and length arithmetic.
- JavaScript strings use UTF-16. Specify behavior for surrogate pairs, lone surrogates, replacement decoding, and embedded NUL where relevant.
- JavaScript `Map`, object property enumeration, and Rust hash maps do not have identical ordering semantics.
- Function identity matters for listener registration and removal.
- Preserve missing, `undefined`, `null`, SQL NULL, and JSON null distinctions wherever observable.
- Do not use `serde_json::Value` as a universal JavaScript value replacement. It cannot faithfully represent every value this API accepts.
- Keep JavaScript-specific conversions at the boundary; keep portable domain types explicit.

## 7. PostgreSQL value compatibility

Port the actual behavior in `types.ts`, including its edge cases.

In particular:

- `INT8` currently becomes a JavaScript number within the safe integer range and a `bigint` outside it. Preserve that behavior.
- Preserve JSON serialization rules, including the existing handling of bigint values and pre-serialized strings.
- Preserve accepted boolean inputs and rejection behavior.
- Preserve date parsing, timezone behavior, precision, and invalid-input behavior.
- Preserve `bytea` encoding and binary output.
- Preserve unknown-type fallback behavior.
- Preserve custom parser and serializer overrides and their precedence.
- Preserve dynamic array-type discovery and `refreshArrayTypes()`.

Test array escaping, dimensions, NULL elements, quoted `"NULL"`, empty arrays, nested arrays, and custom element types.

Do not choose a “more idiomatic” Rust representation that changes JavaScript results.

## 8. Protocol fidelity

`packages/pg-protocol` is a binary protocol implementation. Port its behavior at the byte level.

Preserve:

- Message tags, lengths, endianness, and terminators.
- Signed fields and special length values.
- Incremental parsing across arbitrary chunk boundaries.
- Multiple messages in one chunk.
- Incomplete-message buffering.
- Simple and extended query flows.
- Parse, bind, describe, execute, sync, and error recovery.
- COPY input/output and streaming behavior.
- Notices, notifications, and error fields.

Honor typed-array byte offsets and lengths. A view is not necessarily the entire underlying buffer.

Use checked arithmetic and bounded reads. Malformed input must not cause out-of-bounds access, unchecked allocation growth, or a Rust panic.

If safe rejection differs from an existing malformed-input behavior, document and test that deviation explicitly.

Use golden byte fixtures and differential tests against the TypeScript implementation. Test every possible split point for representative messages.

Do not replace the local implementation with another PostgreSQL protocol library without demonstrating equivalent behavior.

## 9. Query and result compatibility

Preserve the public behavior of:

```text
PGlite constructor overloads
PGlite.create()
waitReady, ready, closed
query(), sql(), exec(), describeQuery()
transaction(), runExclusive()
execProtocol(), execProtocolRaw(), execProtocolRawStream()
listen(), unlisten(), onNotification(), offNotification()
dumpDataDir(), refreshArrayTypes(), close()
```

Inventory additional public exports and supported instance members from the repository rather than assuming this list is exhaustive.

Preserve:

- Parameter inference and explicit `paramTypes`.
- Parameterization and identifier escaping.
- Array and object row modes.
- Field order and `dataTypeID`.
- Duplicate-column-name behavior.
- Empty-query results and multiple result sets.
- `command`, `rowCount`, and `affectedRows`.
- Blob-related query options and results.

In this source, `affectedRows` accumulates across applicable commands in a multi-statement result stream, while `rowCount` describes an individual command. Preserve that distinction.

Preserve structured database errors, SQLSTATE, detail, hint, position, schema/table/column fields where present, and attached query context.

Do not flatten all failures into strings or generic Rust debug output.

## 10. Async execution, transactions, and reentrancy

PGlite uses one PostgreSQL connection per instance. Preserve its serialization model.

Inspect the separate query, transaction, listener, and filesystem synchronization locks. Reproduce their roles and ordering before simplifying them.

Required properties:

- Concurrent JavaScript calls cannot interleave protocol messages incorrectly.
- A transaction owns the connection for its intended lifetime.
- Transaction methods do not reacquire an outer lock and deadlock.
- Callback success, callback rejection, explicit rollback, commit failure, and rollback failure follow the reference behavior.
- Closed transaction handles remain unusable.
- Protocol synchronization and cleanup happen on the correct failure paths.
- User callbacks can reject or throw without corrupting database state.

Use `async fn` where appropriate. Keep the portable core independent of a mandatory native executor.

Do not block the browser event loop. Do not introduce Tokio, threads, or a global executor merely because they are familiar.

JavaScript Promises and Rust futures have different execution and cancellation behavior. Audit when work starts, what happens when a future is dropped, and who completes cleanup after an operation has begun.

Do not:

- Hold a `RefCell` borrow across `.await` or a reentrant host callback.
- Hold a blocking mutex across `.await`.
- Assume an async mutex automatically makes callback reentrancy safe.
- Add `Send` or `Sync` to JavaScript-owned objects without proof.

Use explicit ownership of in-flight work and connection state. Dropping a future must not leave an open transaction or a permanently locked database.

## 11. Emscripten and memory safety

Keep the engine adapter narrow and explicit.

Audit:

- `HEAPU8` reads and writes.
- Memory growth and stale typed-array views.
- `addFunction` / `removeFunction`.
- Stack save/restore operations.
- Initdb and PostgreSQL filesystem sharing.
- PostgreSQL loop entry points and lifecycle callbacks.
- The existing longjmp/exit-status handling.

Preserve the source’s distinction between PostgreSQL control-flow signals and actual errors, including the status values used by `pglite.ts`. Verify their relationship to the engine revision.

Do not allow PostgreSQL longjmp behavior, JavaScript exceptions, or Rust panics to cross a boundary that cannot safely support them. Translate them in the appropriate adapter.

Every registered callback must remain alive until unregistered. Release callbacks exactly once, including initialization-failure paths.

Never retain a view into engine memory across a call that can invalidate it unless the bridge proves it remains valid.

Prefer safe Rust. If `unsafe` is necessary, isolate it and explain its invariants locally. Do not use raw pointers, `transmute`, or unchecked indexing to bypass ownership problems.

## 12. Persistence and lifecycle

Preserve all existing storage modes:

```text
memory://
idb://
opfs-ahp://
file://
plain filesystem paths
custom filesystem implementations
```

Keep runtime-specific host operations in adapters while migrating portable policy and coordination.

Verify:

- Data-directory parsing and validation.
- Initial synchronization.
- Filesystem mount behavior.
- Query and transaction synchronization points.
- `relaxedDurability`.
- Scheduled flushes and shutdown.
- Close/reopen persistence.
- Initialization failures and partial cleanup.
- Dump/load round trips.
- Custom filesystem compatibility.

Do not substitute a Rust in-memory filesystem for Emscripten MEMFS without connecting it to PostgreSQL’s actual filesystem operations.

Do not assume browser `std::fs` can provide IndexedDB or OPFS.

Preserve supported database-directory and archive compatibility. Use matched engine revisions for differential tests.

Rust `Drop` cannot await persistence. Keep an explicit asynchronous close path. Use `Drop` only for synchronous cleanup that is safe at that point.

Do not introduce stronger durability claims than the implementation and tests establish.

## 13. Workers, live queries, extensions, and ecosystem packages

For workers, preserve:

- Initialization handshake.
- Request/response correlation.
- Error propagation.
- Leader and multi-tab coordination.
- Structured-clone and transferable-buffer behavior.
- Notification forwarding.
- Worker shutdown and pending requests.

Workers must not accidentally create multiple independent database writers for one storage directory.

For live queries, preserve initial results, invalidation, retries, batching/debouncing, incremental changes, pagination behavior, cancellation, and unsubscribe cleanup.

For extensions, preserve setup/init/close ordering, preload libraries, bundle loading, namespace objects, and worker client-only setup behavior.

JavaScript extension hooks remain supported through the adapter. Do not require all existing extensions to be rewritten in Rust.

For sync, migrate portable change application and subscription-state logic while preserving transaction boundaries, restart state, and existing transport behavior.

Validate socket, node-postgres, pg_dump, prepopulated filesystem, ICU, React, Vue, and REPL integrations as consumers of the migrated core. Classify every workspace package; do not silently omit packages outside the main library.

## 14. Implementation stages

### Stage A — Baseline and architecture

Produce the compatibility inventory, module map, baseline results, and working engine-boundary prototype.

Record the toolchain, dependency choices, target matrix, and bridge ownership model.

### Stage B — Protocol and value processing

Port protocol reading/writing, message types, value codecs, result parsing, errors, and templating.

Require native Rust unit tests where applicable and JavaScript-facing differential tests.

### Stage C — Database operations

Port initialization coordination, queries, transactions, notifications, COPY, and shutdown.

Make the migrated path selectable in tests. Tests must explicitly prove they are exercising Rust.

### Stage D — Persistence and ecosystem behavior

Integrate all storage backends, workers, extensions, live queries, sync, and dependent packages.

### Stage E — Packaging and cutover

Preserve package exports, declarations, asset loading, ESM/CommonJS behavior, and supported runtime installation flows.

Switch defaults only after the required parity matrix passes.

Keep fallback explicit during development. Never silently fall back to TypeScript after a Rust error; that conceals defects.

Remove superseded implementation code only after its replacement is verified.

## 15. Verification

Run the same behavioral scenarios against the reference and migrated implementations using isolated databases.

Compare:

- Results and JavaScript value types.
- Missing properties versus properties with null/undefined values.
- Errors and metadata.
- Protocol bytes.
- Callback order.
- Transaction outcomes.
- Persisted state after reopen.

Do not normalize away meaningful differences. Any normalization for nondeterministic values must be narrow and documented.

Prioritize existing tests covering:

```text
basic
instantiation
types
array-types
templating
describe-query
exec-protocol
extended-query-error
message-context-leak
query-sizes
notify
live
dump
initdb and filesystem options
runtime and browser storage targets
contrib extensions
```

Use existing repository scripts, confirming their current definitions. Relevant commands include:

```bash
pnpm ts:build
CI=true pnpm --filter @electric-sql/pg-protocol test
CI=true pnpm --filter @electric-sql/pglite test
CI=true pnpm --filter @electric-sql/pglite test:web
pnpm --filter @electric-sql/pglite test:bun
pnpm --filter @electric-sql/pglite test:deno
pnpm --filter @electric-sql/pglite typecheck
pnpm --filter @electric-sql/pglite check:exports
```

After the Rust workspace exists, add formatting, linting, compilation, and tests for its actual supported target/feature combinations.

A native `cargo test` run does not establish browser compatibility.

Run browser coverage in Chromium, Firefox, and WebKit where the repository supports the relevant capability. Test runtime packages in Node.js, Bun, and Deno.

Add targeted regression tests for cross-boundary ownership, memory growth, callback reentrancy, dropped futures, initialization failure, and close during active work.

If a runtime or artifact is unavailable, report that verification as blocked. Do not mark it passed.

## 16. Performance

Establish baselines before making performance claims.

Measure:

- Cold initialization.
- Simple and parameterized query latency.
- Large result sets.
- Protocol serialization/parsing.
- COPY throughput.
- Transaction throughput.
- Persistence synchronization.
- Live-query updates.
- Memory use.
- Compressed package size and Wasm asset size.

Include Rust↔JavaScript and Rust↔engine transfer costs.

Use comparable engine builds, datasets, runtime versions, warmup, and repetitions. Report variability and regressions. Rust is not automatically faster, especially when a second Wasm module introduces copying.

Resolve or explicitly account for every `PERF(port)` marker before cutover.

## 17. Per-module workflow and reporting

For each assigned module or coherent slice:

1. Read the source, callers, dependencies, and tests.
2. Identify observable behavior and ownership.
3. Follow the established module map.
4. Implement the Rust logic and required adapter changes.
5. Compile for relevant targets.
6. Run focused compatibility tests.
7. Update migration records.
8. Report remaining uncertainty accurately.

Use this assignment format:

```text
Source:
Destination:
Dependencies:
Behavior to preserve:
Host responsibilities retained:
Required tests:
Acceptance criteria:
```

Add a compact status comment to migrated modules:

```rust
// PORT STATUS
// source: <repository-relative TypeScript paths>
// baseline: <source revision>
// stage: in-progress | implemented | verified
// verification: <specific tests and targets>
// open issues: <specific unresolved items or none>
```

End each work session with:

- What was migrated.
- What still delegates to TypeScript.
- What verification ran and its results.
- Any behavioral differences.
- Blockers and the next concrete step.

Do not equate confidence, code volume, or successful compilation with compatibility.

## 18. Completion criteria

The migration is complete when:

- Portable implementation responsibilities identified in the module map run in Rust.
- Retained TypeScript is explicitly justified as host integration, framework code, or compatibility surface.
- Public API and package compatibility checks pass.
- Supported runtimes and persistence backends pass their required tests.
- Existing data can be reopened under the supported engine compatibility conditions.
- Protocol recovery, transaction cleanup, and resource lifetimes are verified.
- No required execution path contains a stub, hidden fallback, or unresolved correctness issue.
- Performance and package-size differences are measured and documented.
- A clean checkout can reproduce the build and verification process.

Begin by inspecting the repository and establishing the baseline. Then implement the smallest working Rust-to-engine integration before expanding the port.