export interface AppErrorOptions {
    statusCode?: number;
    retryable?: boolean;
    details?: unknown;
}
export declare class AppError extends Error {
    readonly code: string;
    readonly statusCode: number;
    readonly retryable: boolean;
    readonly details?: unknown;
    constructor(code: string, message: string, opts?: AppErrorOptions);
}
export declare class ValidationError extends AppError {
    constructor(message: string, details?: unknown);
}
export declare class NotFoundError extends AppError {
    constructor(message: string);
}
export declare class NotImplementedError extends AppError {
    constructor(message: string);
}
export declare class IntentExpiredError extends AppError {
    constructor(message: string, details?: unknown);
}
export declare class SignatureError extends AppError {
    constructor(message: string);
}
export declare function formatError(err: unknown): {
    code: string;
    message: string;
};
export declare function isRetryable(err: unknown): boolean;
//# sourceMappingURL=errors.d.ts.map