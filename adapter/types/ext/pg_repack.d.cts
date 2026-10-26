import { PGliteInterface } from '../index.cjs';

declare const pg_repack: {
    name: string;
    setup: (_pg: PGliteInterface, emscriptenOpts: any) => Promise<{
        bundlePath: URL;
    }>;
};

export { pg_repack };
