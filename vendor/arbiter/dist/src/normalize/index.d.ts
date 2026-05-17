export type EncodingTag = "base64" | "rot13" | "hex" | "url" | "homoglyph";
export interface NormalizeResult {
    readonly normalized: string;
    readonly decodedFrom: readonly EncodingTag[];
}
export declare function normalize(input: string): NormalizeResult;
//# sourceMappingURL=index.d.ts.map