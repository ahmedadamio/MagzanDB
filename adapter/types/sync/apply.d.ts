import { PGliteInterface, Row } from '../index.js';
import { ChangeMessage } from '@electric-sql/client';

export declare function applyMessageToTable(opts: {
    pg: PGliteInterface;
    table: string;
    schema?: string;
    message: ChangeMessage<Row>;
    mapColumns?: any;
    primaryKey: string[];
    shapeKey?: string | null;
}): Promise<void>;
