import { Ref, WatchSource, ToRefs, DeepReadonly } from 'vue';
import { PGliteWithLive } from '../live/index.js';
import { Results } from '../index.js';

interface PGliteDependencyInjection<T extends PGliteWithLive> {
    providePGlite: (db: Ref<T | undefined> | (T | undefined)) => void;
    injectPGlite: () => T | undefined;
}
/**
 * Call this function to get a PGlite provider and injector for your Vue application.
 * We can't provide a predefined provider and injector because that would lose type information
 * as the PGlite interface depends on the extensions provided to PGlite.
 *
 * @example
 * This example loses type information about the PGlite extensions:
 * ```
 * provide<typeof db>(PGliteKey, db)
 *
 * // generic PGlite instance type, no extension types
 * const { db } = inject(PGliteKey)
 * ```
 *
 * @returns An object with two functions: `providePGlite` and `injectPGlite`.
 *
 */
declare function makePGliteDependencyInjector<T extends PGliteWithLive>(): PGliteDependencyInjection<T>;
declare const injectPGlite: () => PGliteWithLive | undefined;
declare const providePGlite: (db: PGliteWithLive | Ref<PGliteWithLive | undefined, PGliteWithLive | undefined> | undefined) => void;

type QueryParams = unknown[] | undefined | null;
type QueryResult<T> = Omit<Results<T>, 'affectedRows'> | {
    rows: undefined;
    fields: undefined;
    blob: undefined;
};
type LiveQueryResults<T> = ToRefs<DeepReadonly<QueryResult<T>>>;
declare function useLiveQuery<T = {
    [key: string]: unknown;
}>(query: string | WatchSource<string>, params?: QueryParams | WatchSource<QueryParams> | WatchSource<unknown>[]): LiveQueryResults<T>;
declare namespace useLiveQuery {
    var sql: <T = {
        [key: string]: unknown;
    }>(strings: TemplateStringsArray, ...values: any[]) => LiveQueryResults<T>;
}
declare function useLiveIncrementalQuery<T = {
    [key: string]: unknown;
}>(query: string | WatchSource<string>, params: QueryParams | WatchSource<QueryParams> | WatchSource<unknown>[], key: string | WatchSource<string>): LiveQueryResults<T>;

export { injectPGlite, makePGliteDependencyInjector, providePGlite, useLiveIncrementalQuery, useLiveQuery };
