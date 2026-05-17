import { type KeyObject } from "node:crypto";
export interface KeyPair {
    readonly privateKey: KeyObject;
    readonly publicKey: KeyObject;
}
export declare function loadOrCreateKeyPair(dir?: string): Promise<KeyPair>;
export declare function loadOrCreateKeyPairSync(dir?: string): KeyPair;
export declare function resetKeyPairCache(): void;
//# sourceMappingURL=keys.d.ts.map