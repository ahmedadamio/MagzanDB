import { PGliteInterface } from '../index.js';

declare const pg_partman: {
    name: string;
    setup: (_pg: PGliteInterface, emscriptenOpts: any) => Promise<{
        bundlePath: URL;
    }>;
};

export { pg_partman };
