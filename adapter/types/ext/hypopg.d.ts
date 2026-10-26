import { PGliteInterface } from '../index.js';

declare const hypopg: {
    name: string;
    setup: (_pg: PGliteInterface, emscriptenOpts: any) => Promise<{
        bundlePath: URL;
    }>;
};

export { hypopg };
