import { PGliteInterface } from '../index.cjs';

declare const pgaudit: {
    name: string;
    setup: (_pg: PGliteInterface, emscriptenOpts: any) => Promise<{
        bundlePath: URL;
    }>;
};

export { pgaudit };
