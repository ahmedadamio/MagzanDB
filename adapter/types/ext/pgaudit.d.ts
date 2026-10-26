import { PGliteInterface } from '../index.js';

declare const pgaudit: {
    name: string;
    setup: (_pg: PGliteInterface, emscriptenOpts: any) => Promise<{
        bundlePath: URL;
    }>;
};

export { pgaudit };
