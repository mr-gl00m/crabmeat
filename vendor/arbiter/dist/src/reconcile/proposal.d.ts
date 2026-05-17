export interface Proposal {
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
}
export declare function parseProposal(text: string): Proposal | null;
//# sourceMappingURL=proposal.d.ts.map