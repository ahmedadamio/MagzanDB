import { PGliteInterface } from '../index.js';

declare const pg_textsearch: {
    name: string;
    setup: (_pg: PGliteInterface, emscriptenOpts: any) => Promise<{
        emscriptenOpts: any;
        bundlePath: URL;
        sharedPreloadLibraries: string[];
    }>;
};

export { pg_textsearch };
