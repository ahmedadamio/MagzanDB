# Migration status

Legend: not-started | in-progress | implemented | verified | retained-host | blocked

**Server and browser are both verified targets.** Node, Bun, Deno, and real
Chromium (via playwright-core + headless shell) all pass. The adapter is a
drop-in PGlite replacement on every runtime upstream supports.

## Stage A — baseline and architecture

| item | status | notes |
|---|---|---|
| Repo + submodule revisions recorded | verified | `e752dbe` / `29b6424…` (submodule uninit; artifacts from npm 0.5.11) |
| Engine artifacts identified | verified | `adapter/release/{pglite.js,pglite.wasm,pglite.data,initdb.js,initdb.wasm}` |
| Architecture doc | implemented | `architecture.md` |
| Module map | implemented | `module-map.tsv` |
| Compatibility inventory | implemented | `compatibility.md` |
| Baseline reference tests | verified | `packages/pglite/tests/basic.test.ts` — 60/60 pass on 0.5.11 artifacts |
| Engine-boundary prototype | verified | `pglite-bridge` + `adapter/` — real Emscripten engine end-to-end in Node |

## Stage B — protocol and value processing

| module | status | verification |
|---|---|---|
| pg-protocol reader/writer/messages/parser/serializer | verified | `cargo test -p pglite-protocol` — 16 wire-level tests, byte-exact fixtures |
| types.ts value codecs | verified | `cargo test -p pglite-core` — 24 tests + differential suite |
| parse.ts result assembly | verified | core tests + e2e smoke + diff |
| errors.ts | verified | core tests + diff (severity/code/detail/position/file/line parity) |
| templating.ts | verified | `query()` + `sql`/`identifier`/`raw` container collapse; core tests + e2e + diff |

Notable fidelity details pinned by tests:

- Array parser: shared `s.char` state — after a `{…}` recursion `s.p` sees `}` (suppresses the delimiter push between nested rows).
- Only literal `NULL` (bare, uppercase) maps to null; `"NULL"` quoted and bare `null` stay strings.
- `int8`: in-safe-range → `number`, out-of-range → `bigint`; `BigInt("")` → `0`.
- `Value::Json` encodes as the bare document (Rust→JS only); JS-object params arrive via `$objpairs` → `Value::Object`.
- `Value::Undefined` has an explicit `{"$undefined": true}` tag.
- JS-number JSON formatting (serde_json's `1.0` → JS `1`) in `serialize_json`/`parse_json`.

## Stage C — database operations

| item | status |
|---|---|
| query/exec/describe orchestration over host_exec_sync | verified — smoke 17/17; diff suite |
| transactions / notify / listen | verified — commit+rollback, LISTEN/NOTIFY incl. worker transport |
| locks | verified | JS mutexes (query/transaction/listen/fsSync), `queueMicrotask` dispatch |
| COPY, blob device | verified | copy-to/from-blob diff cases |
| error latching + recovery | verified | first error latched, subsequent rows suppressed; recovery ×10 |
| events (notice/notification) | verified | drained via `SessionEvents` even on error paths |
| public codec maps (`db.parsers`, `db.serializers`), `refreshArrayTypes` | verified | enum array pre/post-refresh diff cases |
| `formatQuery` | verified | via `describeQuery` param OIDs + `SELECT format(...) %L` — 6 diff cases |

## Stage D — persistence, extensions, workers, live queries, sync

| item | status |
|---|---|
| NodeFS persistence cross-process | verified | `persist.mjs` — write/close in process A, reopen/read in process B |
| MemoryFS / initdb tar flow | verified | PROXYFS + `tinytar` dump/load; `dumpDataDir`/`loadDataDir` diff case |
| initdb `fs`-option isolation | verified | inner initdb runs scratch FS; `CountingFS` diff case (initCount=1 both sides) |
| Prepopulated FS (`loadDataDir`) | verified | `prepopulatedfs.js` + generated `release/prepopulatedfs.tgz` — boots without initdb |
| Full ICU (`icuDataDir`) | verified | `icu.js` + `release/icu.76.tgz` — 871 ICU collations |
| IndexedDB (browser) | verified | `idb://` — Emscripten IDBFS — persistence across close/reopen in real Chromium |
| OPFS-AHP (browser) | verified | `src/opfs-ahp.js` — full 734-line port (access-handle pool, WAL, checkpoints) — persistence + WAL replay verified in real Chromium inside a Web Worker (`createSyncAccessHandle` exists only in workers, matching upstream constraints) |
| Custom `BaseFilesystem` (EMFS) | implemented | `fs.js` `createEmscriptenFS` — exercised via NodeFS-adjacent paths |
| Extensions | verified — **34/34 contrib modules** | `test/extensions.mjs`: each module loads its tarball + `CREATE EXTENSION` + functional check (incl. amcheck, bloom, citext, cube, earthdistance, file_fdw, hstore, ltree, moddatetime trigger, pageinspect, pgcrypto, seg, tablefunc, unaccent, uuid-ossp, Apache AGE via raw tarball) |
| Workers | verified | `worker.js`: `PGliteWorker` + `worker()` host; Node `worker_threads` + `BroadcastChannel` e2e — query/exec/transaction/notify/describe. Whole-op RPC (sync session); `connectedTabs` dedup, leader locks (in-process fallback for `navigator.locks`), `sanitizeForClone` at the rpc boundary |
| Live queries | verified | ported `src/live.js` — `live.query`/`live.changes`/`live.incrementalQuery` incl. UPDATE diff tracking |
| Sync (`pglite-sync`) | verified — **pluggable provider design** | `src/sync.js` full port refactored around a `SyncProvider` contract (`init?`, `createStream`, `getShapeState`, message predicates). `src/sync-providers/electric.js` is the first provider (lazy `@electric-sql/*` deps; `electricSync` unchanged). `test/sync-provider.mjs` proves the pipeline end-to-end through an in-memory provider: LSN-buffered commits, insert/update/delete, must-refetch truncate+resync, `onInitialSync`, subscription-state persistence, unsubscribe. `test/sync-apply.mjs` covers apply/state layer. Only Electric's wire protocol against a live server remains unverifiable locally |

## Ecosystem packages

| package | status |
|---|---|
| `pg-protocol` | verified | Rust crate `pglite-protocol` (16 wire tests) + JS serialize used by socket |
| `pglite-node-postgres` (pg Client/Pool) | verified | `src/pg-compat.js` — real `pg@8.14` Pool query/params/error-code checks |
| `pglite-socket` (TCP wire server) | verified | `src/socket.js` — real `pg` client over TCP; 9 checks: params, multi-client queueing, transactions, error propagation, no-crosstalk parallel, over-limit rejection, disconnect recovery |
| `pglite-sync` | see Stage D |
| `pglite-tools` (pg_dump) | verified | `src/tools.js` + vendored `vendor-tools/{pgdump-chunk.js,pg_dump.wasm}` — real SQL dump, `-t` filter, restore round-trip |
| `pglite-icu-full` | verified | `src/icu.js` |
| `pglite-prepopulatedfs` | verified | `src/prepopulatedfs.js` + generated artifact |
| `pglite-age` | verified | `age.tar.gz` — `CREATE EXTENSION`/`LOAD`/`create_graph`/cypher CREATE+MATCH |
| `pglite-extensions/*` (14 pkgs) | verified — **14/14** | `ext/` modules + `test/ext-packages.mjs`: age, postgis, pgtap, pg_ivm, pgmq, pg_textsearch, pg_uuidv7, pg_hashids (published artifacts) + vector, pgaudit, hypopg, pg_repack, plpgsql_check, pg_partman (built locally via `postgres-pglite` docker build — `dist/extensions/other/*.tar.gz` → `adapter/release/`). Each: `CREATE EXTENSION` + functional check (vector dims, `hypopg()`, `plpgsql_check_function_tb`, partman `create_parent`, preload libs for pgaudit/hypopg/pg_repack) |
| `pglite-utils` | n/a | internal helpers — equivalents live in `adapter/src/utils.js` |
| `pglite-react` | verified | `react/` — provider + `useLiveQuery`/`useLiveIncrementalQuery` — real React 19 DOM updates in Chromium |
| `pglite-vue` | verified | `vue/` — provide/inject + `useLiveQuery`/`useLiveIncrementalQuery` — real Vue 3 reactivity in Chromium |
| `pglite-repl` | verified | `repl/` — `Repl` component, `ReplResponse`/`ReplTable`, `psql-describe` `\d` commands, sqlSupport completions, `<pglite-repl>` webcomponent (shadow DOM) — 6/6 in real Chromium via `test/browser/run-repl.mjs` |
| `benchmark` | n/a | dev harness, not a deliverable |

## Stage E — packaging/cutover

| item | status |
|---|---|
| Bridge build | verified | `scripts/build-bridge.sh` → `wasm-bindgen-cli 0.2.129` → `adapter/dist/` |
| Package exports | verified | `.` `./template` `./live` `./worker` `./nodefs` `./basefs` `./opfs-ahp` `./socket` `./pg-compat` `./sync` `./sync/apply` `./tools` `./icu` `./prepopulatedfs` `./contrib/*` `./ext/*` `./react` `./vue` `./repl` `./repl/webcomponent` `./repl/Repl.css` — each with `types`/`import`/`require` conditions |
| Type declarations | verified | `types/` — 68 `.d.ts` + 68 `.d.cts` adapted from upstream generated declarations; tsc node16 typecheck clean for both ESM and CJS consumers |
| CJS output | verified | `scripts/build-cjs.mjs` → `dist-cjs/_runtime.cjs` shared bundle + thin stubs (4MB total); `require()` verified: queries, citext ext, socket server, pg_dump. react/vue/repl bundled separately (optional peers) |
| Self-contained package | verified | `npm pack` → clean-install consumer boots PostgreSQL 18.6, runs queries + socket server with real pg client — engine artifacts relocated into `adapter/release/` (was repo-root) |
| Node | verified | v25 — all suites below |
| Bun | verified | smoke 17/17 + NodeFS persistence |
| Deno | verified | 2.9.8 — `test/deno-smoke.ts` 8/8 (memory, params, exec, errors, tx, describe, notify, NodeFS persistence) |
| Chromium | verified | `test/browser/run.mjs` — playwright-core + cached headless shell: 15/15 core (memory/idbfs/live/worker/opfs-ahp) + 6/6 frameworks (react/vue) + 6/6 repl (CodeMirror input, `\dt` describe, error display, `<pglite-repl>` webcomponent) |

## Remaining gaps

- **Electric wire protocol — logged, deferred.** Sync is a pluggable-provider
  design (`options.provider`); the commit pipeline is fully e2e-verified via
  `test/sync-provider.mjs` against an in-memory provider, and the apply/state
  layer via `test/sync-apply.mjs`. The only unverified path is Electric's
  `MultiShapeStream` against a live Electric sync server (self-hosted Electric
  OSS or their cloud) — the provider code itself is a thin adapter over
  upstream's client. `@electric-sql/client`/`@electric-sql/experimental`
  remain lazy optional peers. To close: stand up a local Electric server,
  point `syncShapeToTables({ url })` at it, and assert rows land.
- ~~Main-entry export gaps~~ — **resolved**: the runtime index now exports
  upstream's full surface — `messages`, `parse`, `protocol` namespaces and
  `Mutex` (async-mutex API: acquire/runExclusive/isLocked/waitForUnlock/
  release/cancel) were added, verified by a runtime export diff against
  `packages/pglite/dist` (missing: none; ours is a superset). `pg-compat`'s
  protocol dependency no longer reaches outside the package — pg-protocol's
  dist (Parser/serialize/message classes) is vendored at
  `adapter/src/vendor/pg-protocol/`.
- ~~6 extension tarballs~~ — **resolved**: built from source via the
  `postgres-pglite` submodule docker build (`build-with-docker.sh`,
  `electricsql/pglite-builder` image). All 6 (`vector`, `pgaudit`, `hypopg`,
  `pg_repack`, `plpgsql_check`, `pg_partman`) now vendored in
  `adapter/release/` and passing `test/ext-packages.mjs`.

## Differential harness

`adapter/test/diff.mjs` runs the same cases against `TsPGlite` (`packages/pglite/dist`) and the
adapter, then deep-compares a canonicalized view (bigint/date/bytes/NaN/blob tagged). Covers:
basic queries, exec multi-result, empty query, type roundtrips, param kinds, rowMode, error
shapes + recovery ×10, tx commit/rollback/propagation/closed-handle, templating
(sql/identifier/raw/nested), notifications (all variants incl. quoted channels + invalid),
describeQuery (params/fields/inserts/no-params/invalid), affectedRows, execProtocol
(simple/extended/raw-error/byte-identity), `types` namespace serializers/parsers,
`startParams`/`postgresqlconf` ctor options, COPY to/from blob, custom parsers/serializers,
enum array types + `refreshArrayTypes`, extensions (uuid-ossp, citext), live queries,
`formatQuery` (6 cases), plpgsql, triggers, xml/xpath, roles, CTE/window, 1MB params,
large objects, `dumpDataDir`/`loadDataDir`, fts (tsvector/tsquery/ts_rank),
initdb `fs`-option init-count, `debounceMutex`, clone, drop-database, MessageContext
bounds, UTC initdb timezone. Current: **139/139**.

Fixed by diff/tool testing:

- Array parser shared `s.char` state (spurious element between nested rows).
- `command` key presence — adapter must omit it when no CommandComplete.
- `describeQuery` error rehydration (was returning raw bridge object).
- `execProtocolStream` error/notice messages: fields flattened onto message (pg-compat requirement).
- `execProtocolRawStream` leaked `#onData` — pg_dump's callback consumed later query output.
- `loadTar` missing the reference's unzip retry on 'File is corrupted'.
- `handleConnection` rejected sockets (over-limit/inactive) had no `error` listener → uncaught ECONNRESET.

## Test totals

- Rust: **40/40** unit tests (`cargo test --workspace`)
- Differential vs TS dist: **139/139**
- smoke 17/17 · persist (cross-process) ✓ · worker e2e ✓ · socket 9/9 · pg-compat 3/3
- sync apply/state ✓ · sync provider e2e **6/6** (in-memory provider, no Electric server) · extensions **34/34** · ext packages **14/14** · pg_dump ✓
- Bun: smoke 17/17 + NodeFS persistence · Deno: 8/8
- Chromium (playwright): **15/15** core browser + **6/6** react/vue + **6/6** repl
