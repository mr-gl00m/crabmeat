# arbiter

Deterministic intent router that mediates tool execution between user requests and LLM consultations. The LLM proposes; the router decides.

Phase 0 scaffold: API surface frozen, audit chain table created, atomic writes wired. Phases 1–6 fill in the parser, consultation, reconciliation, execution, and CrabMeat integration. See `PROJECT_CHARTER.md` and `PROJ_DOC.md`.

```
npm install
npm run typecheck
npm test
```

## API

```ts
import { extractIntent, consult, reconcile, execute, handle } from "arbiter";
```

Four primitives plus a `handle()` convenience wrapper. Each step is independently callable so a consumer can interleave its own logic between them.
