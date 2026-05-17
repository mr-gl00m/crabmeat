import { randomUUID } from "node:crypto";
import { z } from "zod";
import { normalize } from "../normalize/index.js";
import { isCompound } from "./compound.js";
import { parseFileRead } from "./file-read.js";
import { parseFileWrite } from "./file-write.js";
// RT-2026-04-30-013 — zod schemas per IntentAction so Intent.params is
// validated at the parser boundary instead of being a Record<string, unknown>
// every consumer has to defend against. Extra keys are stripped.
const PARAM_SCHEMAS = {
    file_write: z
        .object({
        filename: z.string().min(1),
        absolutePath: z.string().min(1),
        contentNeeded: z.string().min(1),
    })
        .strict(),
    file_read: z
        .object({
        filename: z.string().min(1),
        absolutePath: z.string().min(1),
    })
        .strict(),
    web_search: z
        .object({
        query: z.string().min(1),
    })
        .strict(),
};
export function parseRequest(input) {
    const { normalized, decodedFrom } = normalize(input.request);
    if (isCompound(normalized))
        return null;
    // parseNewsSearch and parseWebSearch are intentionally NOT routed here.
    // execWebSearch in execute/tools.ts is a v0.1.0 stub that echoes the
    // query back without performing a real search. Routing search intents
    // through arbiter would short-circuit the gateway's fall-through to
    // inference, where CrabMeat's real web_search tool (Tavily/Brave/DDG)
    // lives — every news/search query would get a useless echo instead of
    // an actual answer. Re-enable these once execWebSearch is implemented.
    const parsed = parseFileWrite(normalized, input.workspace) ??
        parseFileRead(normalized, input.workspace);
    if (parsed === null)
        return null;
    const validation = PARAM_SCHEMAS[parsed.action].safeParse(parsed.params);
    if (!validation.success)
        return null;
    const intent = {
        id: randomUUID(),
        action: parsed.action,
        params: validation.data,
        effectClass: parsed.effectClass,
        parsedAt: Date.now(),
        ...(decodedFrom.length > 0 ? { decodedFrom: decodedFrom.join(",") } : {}),
    };
    return { intent, decodedFrom };
}
//# sourceMappingURL=index.js.map