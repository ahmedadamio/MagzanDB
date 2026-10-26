import { PGliteInterface } from '../index.cjs';

declare const hypopg: {
    name: string;
    setup: (_pg: PGliteInterface, emscriptenOpts: any) => Promise<{
        bundlePath: URL;
    }>;
};

export { hypopg };
