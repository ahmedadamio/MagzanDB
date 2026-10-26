import { PGliteInterface } from '../index.js';

declare const plpgsql_check: {
    name: string;
    setup: (_pg: PGliteInterface, emscriptenOpts: any) => Promise<{
        bundlePath: URL;
    }>;
};

export { plpgsql_check };
