export declare function readText(filePath: string): Promise<string>;
export declare function readJsonFile<T>(filePath: string): Promise<T>;
export declare function fileExists(filePath: string): Promise<boolean>;
export interface AtomicWriteOpts {
    readonly mode?: number;
}
export declare function atomicWriteText(filePath: string, content: string, opts?: AtomicWriteOpts): Promise<void>;
export declare function atomicWriteJson<T>(filePath: string, data: T, opts?: AtomicWriteOpts): Promise<void>;
export declare function atomicWriteTextSync(filePath: string, content: string, opts?: AtomicWriteOpts): void;
//# sourceMappingURL=atomic.d.ts.map