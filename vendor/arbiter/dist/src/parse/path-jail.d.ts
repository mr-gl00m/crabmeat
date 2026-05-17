export interface PathJailResult {
    readonly ok: boolean;
    readonly reason?: string;
    readonly path?: string;
}
/**
 * Cheap "does this look like a filename?" check used by the file_read
 * and file_write parsers to reject extracted destinations that are
 * obviously not paths (e.g. parsed verb-object instead of object-path).
 * Treats anything with an extension or a path separator as file-like.
 */
export declare function looksFileLike(s: string): boolean;
/**
 * Cheap "does this look like a path-injection attempt embedded in a
 * search query / topic?" check. Used by web-search and news-search
 * parsers to reject queries that smuggle traversal or absolute-path
 * tokens — those would never be legitimate search topics, but they're
 * a classic prompt-injection vector where the attacker hopes the
 * downstream backend interprets the topic as a file path.
 *
 * Distinct from jailPath: jailPath is for *parsed file destinations*
 * that we intend to resolve against a workspace. This one is for
 * *opaque text* (a search query, a topic name) where any path-shaped
 * fragment is suspicious by definition.
 */
export declare function looksLikePathInjection(s: string): boolean;
export declare function isUnsafeWorkspace(workspace: string): {
    unsafe: boolean;
    reason?: string;
};
export declare function jailPath(raw: string, workspace: string): PathJailResult;
export declare function verifyJailedPath(jailedAbsolute: string, workspace: string): Promise<PathJailResult>;
//# sourceMappingURL=path-jail.d.ts.map