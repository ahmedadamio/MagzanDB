import React from 'react';
import { PGliteWithLive, LiveQueryResults, LiveQuery } from '../live/index.js';

interface Props<T extends PGliteWithLive> {
    children?: React.ReactNode;
    db?: T;
}
type UsePGlite<T extends PGliteWithLive> = (db?: T) => T;
interface PGliteProviderSet<T extends PGliteWithLive> {
    PGliteProvider: PGliteProvider<T>;
    usePGlite: UsePGlite<T>;
}
/**
 * Create a typed set of {@link PGliteProvider} and {@link usePGlite}.
 */
declare function makePGliteProvider<T extends PGliteWithLive>(): PGliteProviderSet<T>;
type PGliteProvider<T extends PGliteWithLive> = (props: Props<T>) => React.JSX.Element;
declare const PGliteProvider: PGliteProvider<PGliteWithLive>;
declare const usePGlite: UsePGlite<PGliteWithLive>;

declare function useLiveQuery<T = {
    [key: string]: unknown;
}>(query: string, params?: unknown[] | null): LiveQueryResults<T> | undefined;
declare function useLiveQuery<T = {
    [key: string]: unknown;
}>(liveQuery: LiveQuery<T>): LiveQueryResults<T>;
declare function useLiveQuery<T = {
    [key: string]: unknown;
}>(liveQueryPromise: Promise<LiveQuery<T>>): LiveQueryResults<T> | undefined;
declare namespace useLiveQuery {
    var sql: <T = {
        [key: string]: unknown;
    }>(strings: TemplateStringsArray, ...values: any[]) => LiveQueryResults<T> | undefined;
}
declare function useLiveIncrementalQuery<T = {
    [key: string]: unknown;
}>(query: string, params: unknown[] | undefined | null, key: string): LiveQueryResults<T> | undefined;

export { PGliteProvider, makePGliteProvider, useLiveIncrementalQuery, useLiveQuery, usePGlite };
