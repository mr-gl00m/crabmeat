import { z } from "zod";
import { HOOK_EVENTS, type HookEvent } from "./types.js";

const hookEventEnum = z.enum(HOOK_EVENTS as unknown as [HookEvent, ...HookEvent[]]);

const functionHookHandlerSchema = z.object({
  type: z.literal("function"),
  id: z.string().min(1).max(64),
  module: z.string().min(1),
  // Optional named export; defaults to the module's default export.
  export: z.string().optional(),
  timeout: z.number().int().min(100).max(60_000).default(5_000),
});

const commandHookHandlerSchema = z.object({
  type: z.literal("command"),
  id: z.string().min(1).max(64),
  run: z.string().min(1),
  timeout: z.number().int().min(100).max(60_000).default(15_000),
});

export const hookHandlerSchema = z.discriminatedUnion("type", [
  functionHookHandlerSchema,
  commandHookHandlerSchema,
]);

const hookHandlerMapSchema = z
  .record(hookEventEnum, z.array(hookHandlerSchema).default([]))
  .default({});

export const hooksConfigSchema = z
  .object({
    // Hard kill switch — registry returns no handlers for any event.
    disableAll: z.boolean().default(false),
    // Policy mode: only managed hooks run, user hooks ignored. Reserved
    // for the cascade work (Phase 2.5A). Honored at schema level now so
    // the structure doesn't churn later.
    managedOnlyMode: z.boolean().default(false),
    // Event → handler list. Handlers within an event run in declared
    // order; first blocking result short-circuits the rest.
    handlers: hookHandlerMapSchema,
  })
  .default({});

export type HooksConfig = z.infer<typeof hooksConfigSchema>;
export type HookHandlerConfig = z.infer<typeof hookHandlerSchema>;
export type FunctionHookHandlerConfig = z.infer<typeof functionHookHandlerSchema>;
export type CommandHookHandlerConfig = z.infer<typeof commandHookHandlerSchema>;
