import { EventEmitter } from 'events';
import { PGlite } from './index.cjs';

export interface Config {
    pglite: PGlite;
}
export declare class PGlitePgConfig {
    constructor(config: Config);
    readonly connection: Connection;
    readonly poolSize: number;
    readonly password: string;
    readonly user: string;
    readonly database: string;
    readonly port: number;
    readonly host: string;
}
export declare class Connection extends EventEmitter {
    #private;
    _connecting: boolean;
    readonly stream: {
        destroy: () => void;
    };
    parsedStatements: {};
    submittedNamedStatements: {};
    constructor(config: Config);
    connect(_port: number, _host: string): void;
    requestSsl(): void;
    startup(_config: any): void;
    cancel(_processID: any, _secretKey: any): void;
    password(_password: string): void;
    sendSASLInitialResponseMessage(mechanism: any, initialResponse: any): void;
    sendSCRAMClientFinalMessage(additionalData: any): void;
    query(text: string): void;
    parse(query: any): void;
    bind(config: any): void;
    execute(config: any): void;
    flush(): void;
    sync(): void;
    end(): void;
    close(msg: any): void;
    describe(msg: any): void;
    sendCopyFromChunk(chunk: any): void;
    endCopyFrom(): void;
    sendCopyFail(msg: any): void;
    ref(): void;
    unref(): void;
}
