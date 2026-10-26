/* tslint:disable */
/* eslint-disable */

export class BridgeSession {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Session codec keys — backs `db.serializers`/`db.parsers` enumeration.
     * Returns `{parsers: [{oid}|{name}], serializers: [...]}`.
     */
    codec_key_list(): string;
    /**
     * `describeQuery`.
     */
    describe_query(query: string, options_json: string): string;
    /**
     * `exec` — simple protocol, multi-statement.
     */
    exec(query: string, options_json: string): string;
    /**
     * `execProtocol` — raw passthrough with parsing, error latching and
     * event collection in Rust. Returns `{data: base64? -> Uint8Array,
     * messages: [..], events}`; we return data via a wrapper object JSON
     * plus a byte array to keep ABI simple.
     */
    exec_protocol(message: Uint8Array, options_json: string): any;
    /**
     * `execProtocolStream` — messages + events only.
     */
    exec_protocol_stream(message: Uint8Array, options_json: string): string;
    /**
     * `_initArrayTypes` — discovers array OIDs via an internal query.
     */
    init_array_types(force: boolean): string;
    constructor();
    /**
     * `parseType(x, oid)` against the session map. `x` may be null.
     * Returns tagged-JSON.
     */
    parse_value(x: string | null | undefined, type_id: number): string;
    /**
     * `query` — extended protocol. `params`/`options` are JSON strings
     * (params tagged). Returns a JSON string.
     */
    query(query: string, params_tagged: string, options_json: string): string;
    /**
     * `query(strings, ...values)` templating — values arrive as a JSON array
     * of template markers `{"$part": s}` / `{"$cont": {...}}` / tagged values.
     * Returns `{query, params}` (params tagged-encoded JSON).
     */
    query_template(strings_json: string, raw_json: string, values_json: string): string;
    /**
     * Merge host-registered parsers/serializers into the instance maps
     * (`{typeKey: callbackId}`). Called at construction for
     * `options.parsers`/`options.serializers`.
     */
    register_codecs(parsers_json: string, serializers_json: string): void;
    /**
     * `serializers[oid](x)` against the session map (includes array types +
     * instance customizations). `tagged` is a tagged-JSON value.
     */
    serialize_value(type_id: number, tagged: string): string;
    /**
     * Register host codec callbacks (or pass undefined to clear).
     */
    set_host_callbacks(call_parser?: Function | null, call_serializer?: Function | null): void;
    set_in_transaction(v: boolean): void;
    /**
     * Register `execRawSync(Uint8Array) -> Uint8Array`.
     */
    set_transport(f: Function): void;
}

/**
 * `arrayParser(x, typarray)` over builtin element codecs — exposed so the
 * adapter's `types` namespace can offer it without a session.
 */
export function codec_array_parse(x: string, elem_oid: number | null | undefined, typarray: number): string;

/**
 * `arraySerializer(xs, serializer-oid, typarray)`.
 */
export function codec_array_serialize(tagged: string, elem_oid: number | null | undefined, typarray: number): string;

/**
 * Enumerate the builtin codec keys (oids + handler names) so the adapter can
 * build the enumerable `parsers`/`serializers` tables. Name keys carry the
 * handler's `to` OID so they can still invoke the codec.
 */
export function codec_keys(): string;

/**
 * `parseType(x, type)` over the builtin handler table. `x` may be null →
 * tagged null. Returns the tagged-JSON encoded value.
 */
export function codec_parse_type(x: string | null | undefined, type_id: number): string;

/**
 * `serializers[oid](x)` over the builtin handler table. `x` is tagged JSON.
 */
export function codec_serialize(type_id: number, tagged: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_bridgesession_free: (a: number, b: number) => void;
    readonly bridgesession_codec_key_list: (a: number) => [number, number];
    readonly bridgesession_describe_query: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly bridgesession_exec: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly bridgesession_exec_protocol: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly bridgesession_exec_protocol_stream: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly bridgesession_init_array_types: (a: number, b: number) => [number, number, number, number];
    readonly bridgesession_new: () => number;
    readonly bridgesession_parse_value: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly bridgesession_query: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly bridgesession_query_template: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly bridgesession_register_codecs: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly bridgesession_serialize_value: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly bridgesession_set_host_callbacks: (a: number, b: number, c: number) => void;
    readonly bridgesession_set_in_transaction: (a: number, b: number) => void;
    readonly bridgesession_set_transport: (a: number, b: any) => void;
    readonly codec_array_parse: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly codec_array_serialize: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly codec_keys: () => [number, number];
    readonly codec_parse_type: (a: number, b: number, c: number) => [number, number, number, number];
    readonly codec_serialize: (a: number, b: number, c: number) => [number, number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
