# Compatibility inventory

Observed-behavior notes distilled from the reference at `e752dbe`. Everything
here must be preserved or explicitly deviated-with-tests.

## Public API surface (packages/pglite)

- `new PGlite(dataDir?, options?)`, `new PGlite(options?)`,
  `PGlite.create(...)` overloads.
- Instance: `waitReady` (Promise), `ready`, `closed`, `debug`, `dataDir`,
  `Module`, `ENV`, `fs`, static `paths`, `DEFAULT_RECV_BUF_SIZE`,
  `MAX_BUFFER_SIZE`, `defaultStartParams`.
- Methods: `query`, `sql`, `exec`, `describeQuery`, `transaction`,
  `execProtocol`, `execProtocolRaw`, `execProtocolRawSync` (used by worker
  paths), `execProtocolRawStream`, `execProtocolStream` (BasePGlite abstract,
  implemented in pglite.ts), `runExclusive`, `listen`, `unlisten`,
  `onNotification`, `offNotification`, `dumpDataDir`, `refreshArrayTypes`,
  `close`, `clone`, `callMain`, `copyToFS`, `isInTransaction`,
  `handleExternalCmd`, `[Symbol.asyncDispose]`, `_runExclusiveQuery`,
  `_runExclusiveTransaction`, `_runExclusiveListen`, `_handleBlob`,
  `_getWrittenBlob`, `_cleanupBlob`, `_checkReady`, `syncToFs`,
  `externalCommandStreamFd`.
- Subpath exports: `.`, `./template`, `./live`, `./worker`, `./nodefs`,
  `./opfs-ahp`, `./basefs`, `./contrib/*`.
- Options: `noInitDb`, `dataDir`, `username`, `database`, `fs`, `debug`,
  `relaxedDurability`, `extensions`, `loadDataDir`, `icuDataDir`,
  `initialMemory`, `pgliteWasmModule`, `initdbWasmModule`, `fsBundle`,
  `parsers`, `serializers`, `startParams`, `initDbStartParams`,
  `postgresqlconf`, `onStdout`, `onStderr`.
- Results: `{rows, fields:[{name,dataTypeID}], command?, affectedRows?,
  rowCount?, blob?}`. `affectedRows` accumulates over
  INSERT/UPDATE/DELETE/COPY/MERGE across a multi-statement stream;
  `rowCount` is per-statement and absent when the tag has no count
  (`Number.isNaN` check). Empty result stream still yields one empty
  `{affectedRows:0,rows:[],fields:[]}` result.

## Protocol behavior (packages/pg-protocol)

- Big-endian framing: 1-byte code + int32 length incl. itself excl. code.
- Incremental parser keeps leftover bytes across `parse()` calls; growth
  doubles buffer; on consume-all it resets to the empty buffer.
- `length > 0` guard before dispatch; malformed/unknown code produces a
  `DatabaseError` named `error` with `received invalid response: <hex>` —
  NOT a throw at the parse site (it flows through the callback as an error
  message). Parser buffer is reset only when `#handlePacket` *throws*.
- DataRow field length `-1` → `null`; other lengths → UTF-8 string.
- Serializers: `query` 'Q', `parse` 'P', `bind` 'B', `execute` 'E'
  (fast-path constant `E00000009 0000` when no portal/rows), `describe` 'D'
  (`{type:'S'|'P', name?}` — cached constants when name absent), `close` 'C',
  `flush`/`sync`/`end`/`copyDone` single-code buffers, `copyData` 'd',
  `copyFail` 'f', `password` 'p', `startup` (no code; len int32 prefix,
  proto 3.0, opts + `client_encoding=UTF8`, trailing NUL), `requestSsl`
  (8 bytes, 80877103), `cancel` (16 bytes, 1234/5678),
  `sendSASLInitialResponseMessage`, `sendSCRAMClientFinalMessage`.
- `parse` warns via console.error when statement name > 63 chars (behavior
  is observable — keep the side channel in the adapter).
- `bind` writes param format+len pairs (per-value format 0/1 then length
  then bytes; `-1` for null), trailing result format int16.
- `byteLengthUtf8` handles surrogate pairs per the reference algorithm.

## Type/value behavior (types.ts)

- OID constants exactly as in `types.ts`.
- INT8 → `number` if `Number.MIN_SAFE_INTEGER <= n <= Number.MAX_SAFE_INTEGER`
  else `bigint`.
- `json`/`jsonb` serializer: string params pass through unchanged; other
  values `JSON.stringify` with bigint→string replacer.
- boolean serializer accepts: JS bool, `1`/`0` numbers, case-insensitive
  trimmed `true/t/yes/y/on/1` and `false/f/no/n/off/0`; everything else
  throws `Invalid input for boolean type`.
- date family serializer: string passthrough, number → `new Date(x).toISOString()`,
  Date → `toISOString()`, else throw `Invalid input for date type`.
  Parser: `new Date(x)` — retained host-side (JS Date.parse semantics).
- bytea: serialize `Uint8Array` → `'\x'+hex` (lowercase, pad 2); else throw.
  Parse `'\x<hex>'` → `Uint8Array`.
- Unknown OID → raw string passthrough.
- Per-query `parsers`/`serializers` option overrides instance maps, which
  override defaults.
- `arraySerializer`: non-array input returned unchanged; empty → `'{}'`;
  nested arrays recurse; delimiter `;` only for typarray 1020 (`_box`),
  else `,`; `undefined`→`null`; `null`→`null`; else `"`+escaped(serialized)+`"`.
- `arrayParser`: shared mutable state module-level (reentrancy hazard —
  Rust port uses explicit struct state); honors quoting, `\` escapes,
  `NULL` (unquoted) → null, quoted `"NULL"` → string, `;` delim for 1020;
  trailing-element tail handling `x.slice(last, i+1)` quirk preserved.
- `_initArrayTypes` SQL + `refreshArrayTypes` re-read; array serializers are
  bound to element serializers *at discovery time*.

## Query orchestration (base.ts / pglite.ts)

- `query` = extended protocol: Parse → Describe(S) → serialize params via
  `paramTypes`/inferred OIDs from ParameterDescription → Bind → Describe(P)
  → Execute → Sync (Sync in `finally`, always sent).
- param `null`/`undefined` → protocol null (-1); else
  `options.serializers?.[oid] ?? this.serializers[oid] ?? param.toString()`.
- `exec` = simple 'Q' + Sync; multi-statement → multiple result sets.
- `describeQuery` = Parse → Describe(S) → Sync; returns
  `{queryParams:[{dataTypeID,serializer}], resultFields:[{name,dataTypeID,parser}]}`.
- Locks: `#transactionMutex` wraps public `query`/`exec`/`transaction`;
  `#queryMutex` wraps `#runQuery`/`#runExec`/`dumpDataDir`/`close` wait;
  `#listenMutex` wraps listen/unlisten; `#fsSyncMutex` serializes fs sync
  with `#fsSyncScheduled` coalescing. Order: transaction outer, query inner.
- `transaction(cb)`: BEGIN → `tx` handle (`checkClosed` throws
  `Transaction is closed`) → cb ok → COMMIT; cb throw → ROLLBACK → rethrow;
  explicit `tx.rollback()` marks closed and skips auto-commit;
  `#inTransaction` suppresses per-query `syncToFs`.
- DatabaseError during extended query: captured into `currentQuery.
  databaseError` when `throwOnError`, first error wins, remaining messages
  dropped (`#parse` returns null once an error is latched); thrown after the
  raw exchange completes, protocol parser reset on throw.
- NoticeMessage → `onNotice` callback (+console.warn at debug>0); never
  thrown.
- NotificationResponseMessage → `#notifyListeners.get(channel)` then global
  listeners, each via `queueMicrotask`.
- `execProtocol*` family: `execProtocol` returns `{messages,data}`;
  `execProtocolRaw` returns raw bytes; `execProtocolRawStream` routes raw
  chunks to `onRawData` without parsing; `execProtocolStream` returns
  BackendMessage[]. `syncToFs` default true on the Raw variants.
- `execProtocolRawSync`: `message[0]==='X'` → empty; `message[0]===0` →
  startup-packet path (`_pgl_getMyProcPort`, `_ProcessStartupPacket(port,
  true, true)`, `_pgl_sendConnData`, flush). Otherwise loop
  `_PostgresMainLoopOnce` while `readOffset < len` OR
  `_pq_buffer_remaining_data() > 0`; catch → `stackSave/Restore` +
  `status===100` → `_PostgresMainLongJmp`; finally
  `_PostgresSendReadyForQueryIfNecessary` + `_pgl_pq_flush`.
- Engine control codes: `POSTGRES_MAIN_LONGJMP=100`, `PGLITE_EXIT_ALIVE=99`.
- Input buffer growth: `len + (len>>1) + required`, capped `2^30`.
- `listen`: `pglUtils.toPostgresName` (unquoted → lowercase; `"quoted"` →
  verbatim inner); registers cb before `LISTEN <channel>` exec; failure
  rolls back registration; returned closer calls unlisten with optional tx.
  `unlisten` deletes cb, and when set empties → `UNLISTEN`.
- `syncToFs`: coalesced by `#fsSyncScheduled`; under `relaxedDurability`
  it fires without await (detached).
- `close()`: `_checkReady` → queryMutex → closing → extension closers →
  `_pgl_setPGliteActive(0)` → `execProtocol(serialize.end())` →
  `_pgl_run_atexit_funcs` → `removeFunction` x2 → `fs.closeFs()` →
  `_emscripten_force_exit(0)` → `mod=undefined`. ExitStatus(0) tolerated.
- Errors: `PGliteError` = DatabaseError + `query`, `params`,
  `queryOptions` attached (mutates the DatabaseError instance).

## Engine/module behaviors (pglite.ts, initdb.ts)

- `defaultStartParams` exact list incl. `--single -F -O -j` and `-c` GUCs.
- `ENV`: HOME/USER/LOGNAME=postgres, PGDATA, PGUSER (options.username ??
  'postgres'), PGDATABASE (options.database ?? 'postgres'), LANG/LC_*=
  en_US.UTF-8, TZ=PGTZ=UTC, PGCLIENTENCODING=UTF8, ICU_DATA=/pglite/icu,
  plus PGLITE_ENV override merge.
- `.pgpass` chmod 0600; initdb/postgres exe chmod 0555.
- initdb: separate `PGlite` instance (fresh MEMFS — `fs` forced undefined),
  `noInitDb` + cleared options; `initdb.js` module mounts `PROXYFS` at
  `/pglite` → scratch pg module FS; initdb calls `system()`/`popen()` which
  are intercepted to invoke `pg.callMain(postgresArgs)` on the *scratch*
  module (HEAPU8 snapshot/restore around it); pclose ordering calls
  deferred pgmain; freopen redirects pgstdin/pgstdout between the two
  modules; on success scratch `dumpDataDir('none')` → `loadTar` into real
  `PGDATA`. initdb args: `--allow-group-access --encoding UTF8
  --locale=C.UTF-8 --locale-provider=libc --auth=trust` +
  `initDbStartParams`. Non-zero exit tolerated only when stderr contains
  `exists but is not empty`.
- `callMain` returns must equal `PGLITE_EXIT_ALIVE` (99) when starting
  single mode, else `PGlite failed to initialize properly`.
- `handleExternalCmd`: only `locale -a` + mode `r` is handled → `_fopen` of
  bundled `/pglite/locale-a`; anything else throws `Unhandled cmd`.
- `pgl_set_system_fn` returns 1 (blocks real system()).
- `/dev/blob` char device major 64 minor 0; read from `#queryReadBuffer`,
  write appends `#queryWriteChunks`, llseek supports whence 0/1/2 with
  `ErrnoError(28)` on negative.
- username option → `SET ROLE <username>;` exec post-init.
- `postgresqlconf` string|string[] → write to `PGDATA/postgresql.conf`;
  merges `shared_preload_libraries` with extension requirements.
- `loadDataDir`/`fsBundle`/`icuDataDir`/`pgliteWasmModule`/
  `initdbWasmModule` overrides as described in options.
- `dumpDataDir` → tar of PGDATA (tinytar), gzip unless `none`;
  File where available else Blob; filename `<dbname>.tar[.gz]`.

## dataDir parsing

- `file://<path>` → nodefs; `idb://` → idbfs; `opfs-ahp://` → opfs-ahp;
  `memory://`/undefined → memoryfs; bare path → nodefs; `file://` with
  empty remainder throws `Invalid dataDir, must be a valid path`.
