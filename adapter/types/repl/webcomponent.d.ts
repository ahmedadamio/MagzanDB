import { PGlite } from '../index.js';
import { Extension } from '@uiw/react-codemirror';
export type { ReplProps, ReplTheme } from './index.js';
export { defaultLightThemeInit, defaultLightTheme, defaultDarkThemeInit, defaultDarkTheme, } from './index.js';
export declare class PGliteREPL extends HTMLElement {
    #private;
    constructor();
    static get observedAttributes(): string[];
    connectedCallback(): void;
    attributeChangedCallback(_name: string, oldValue: unknown, newValue: unknown): void;
    disconnectedCallback(): void;
    get pg(): PGlite | undefined;
    set pg(pg: PGlite | undefined);
    get lightTheme(): Extension | undefined;
    set lightTheme(lightTheme: Extension | undefined);
    get darkTheme(): Extension | undefined;
    set darkTheme(darkTheme: Extension | undefined);
    render(): void;
}
