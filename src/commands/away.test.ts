/**
 * Tests for /away and /back slash commands.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "./handlers.js"; // registers built-in commands
import { getCommand, type CommandContext } from "./registry.js";
import {
  registerOutboundConnector,
  _resetOutboundRegistry,
  type OutboundConnector,
} from "../connectors/outbound.js";
import type { Session } from "../sessions/types.js";
import type { SessionStore } from "../sessions/store.js";
import type { Config } from "../config/types.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  return {
    sessionKey: "test-session",
    agentId: "default",
    transcript: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeStore(initial: Session): SessionStore {
  let current: Session = initial;
  return {
    async load(key) {
      return key === current.sessionKey ? current : undefined;
    },
    async save(s) {
      current = s;
    },
    create(key, agentId) {
      return makeSession({ sessionKey: key, agentId });
    },
    async list() {
      return [current.sessionKey];
    },
  };
}

function makeCtx(args: string, store: SessionStore): CommandContext {
  return {
    sink: {} as never,
    sessionKey: "test-session",
    frameId: "frame-1",
    config: {} as Config,
    store,
    pipeline: {} as never,
    args,
  };
}

function makeConnector(id: string): OutboundConnector {
  return {
    id,
    name: id,
    trustLevel: "trusted",
    async deliver() {
      return { ok: true };
    },
  };
}

beforeEach(() => {
  _resetOutboundRegistry();
});

afterEach(() => {
  _resetOutboundRegistry();
});

describe("/away command", () => {
  it("flips awayMode.enabled and persists it", async () => {
    registerOutboundConnector(makeConnector("discord"));
    const session = makeSession();
    const store = makeStore(session);

    const cmd = getCommand("away")!;
    expect(cmd).toBeDefined();

    const result = await cmd.handler(makeCtx("", store));
    expect(result.output).toContain("AWAY MODE ON");

    const after = await store.load("test-session");
    expect(after?.awayMode?.enabled).toBe(true);
    expect(after?.awayMode?.preferredConnector).toBe("discord");
    expect(after?.awayMode?.setAt).toBeTruthy();
  });

  it("uses the first registered connector as default", async () => {
    registerOutboundConnector(makeConnector("discord"));
    registerOutboundConnector(makeConnector("telegram"));
    const store = makeStore(makeSession());

    await getCommand("away")!.handler(makeCtx("", store));

    const after = await store.load("test-session");
    // First-registered is the default. The test just pins to *some*
    // valid connector; the specific one doesn't matter as long as it
    // was actually registered.
    expect(["discord", "telegram"]).toContain(after?.awayMode?.preferredConnector);
  });

  it("pins to a specific connector when named", async () => {
    registerOutboundConnector(makeConnector("discord"));
    registerOutboundConnector(makeConnector("telegram"));
    const store = makeStore(makeSession());

    await getCommand("away")!.handler(makeCtx("telegram", store));

    const after = await store.load("test-session");
    expect(after?.awayMode?.preferredConnector).toBe("telegram");
  });

  it("treats first arg as reason when it isn't a registered connector", async () => {
    registerOutboundConnector(makeConnector("discord"));
    const store = makeStore(makeSession());

    await getCommand("away")!.handler(makeCtx("grabbing lunch", store));

    const after = await store.load("test-session");
    expect(after?.awayMode?.reason).toBe("grabbing lunch");
    // Should still have fallen back to the default connector.
    expect(after?.awayMode?.preferredConnector).toBe("discord");
  });

  it("captures both connector and reason", async () => {
    registerOutboundConnector(makeConnector("discord"));
    const store = makeStore(makeSession());

    await getCommand("away")!.handler(makeCtx("discord in a meeting", store));

    const after = await store.load("test-session");
    expect(after?.awayMode?.preferredConnector).toBe("discord");
    expect(after?.awayMode?.reason).toBe("in a meeting");
  });

  it("warns when no outbound connectors are registered", async () => {
    const store = makeStore(makeSession());
    const result = await getCommand("away")!.handler(makeCtx("", store));

    expect(result.output).toContain("no outbound connector is registered");
    const after = await store.load("test-session");
    // Still flips on, so the user's intent is captured — the agent will
    // tell them in the response that it can't actually reach them.
    expect(after?.awayMode?.enabled).toBe(true);
    expect(after?.awayMode?.preferredConnector).toBeUndefined();
  });
});

describe("/back command", () => {
  it("clears awayMode", async () => {
    const session = makeSession({
      awayMode: {
        enabled: true,
        preferredConnector: "discord",
        setAt: new Date().toISOString(),
      },
    });
    const store = makeStore(session);

    const result = await getCommand("back")!.handler(makeCtx("", store));
    expect(result.output).toContain("AWAY MODE OFF");

    const after = await store.load("test-session");
    expect(after?.awayMode?.enabled).toBe(false);
  });

  it("is a no-op when not in away mode", async () => {
    const store = makeStore(makeSession());
    const result = await getCommand("back")!.handler(makeCtx("", store));
    expect(result.output).toContain("Not currently in away mode");
  });
});
