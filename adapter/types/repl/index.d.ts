import { Extension } from '@uiw/react-codemirror';
import { CreateThemeOptions } from '@uiw/codemirror-themes';
import { PGliteInterface } from '../index.js';
export type ReplTheme = 'light' | 'dark' | 'auto';
type ThemeInit = (options?: Partial<CreateThemeOptions>) => Extension;
export declare const defaultLightThemeInit: ThemeInit;
export declare const defaultLightTheme: Extension;
export declare const defaultDarkThemeInit: ThemeInit;
export declare const defaultDarkTheme: Extension;
export interface ReplProps {
    pg?: PGliteInterface;
    border?: boolean;
    lightTheme?: Extension;
    darkTheme?: Extension;
    theme?: ReplTheme;
    showTime?: boolean;
    disableUpdateSchema?: boolean;
}
export declare function Repl({ pg: pgProp, border, lightTheme, darkTheme, theme, showTime, disableUpdateSchema, }: ReplProps): import("react/jsx-runtime").JSX.Element;
export {};

export declare function ReplResponse(props: { response: any; showTime: boolean }): import("react/jsx-runtime").JSX.Element;
export declare function ReplTable(props: { result: any }): import("react/jsx-runtime").JSX.Element;
export declare function runQuery(query: string, pg: PGliteInterface): Promise<any>;
export declare function runDescribe(query: string, pg: PGliteInterface): Promise<any>;
export declare function getSchema(pg: PGliteInterface): Promise<Record<string, string[]>>;
export declare function makeSqlExt(config?: any): any;
