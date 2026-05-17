import { describe, it, expect, beforeEach } from "vitest";
import {
  registerInboundConnector,
  unregisterInboundConnector,
  getInboundConnector,
  listInboundConnectors,
  hasInboundConnector,
  _resetInboundRegistry,
  type InboundConnector,
} from "./inbound.js";

function makeStub(id: string): InboundConnector {
  return {
    id,
    name: id,
    trustLevel: "trusted",
    async start() {
      // no-op
    },
    async stop() {
      // no-op
    },
  };
}

beforeEach(() => {
  _resetInboundRegistry();
});

describe("inbound connector registry", () => {
  it("registers and retrieves a connector", () => {
    const c = makeStub("email-imap");
    registerInboundConnector(c);
    expect(getInboundConnector("email-imap")).toBe(c);
    expect(hasInboundConnector("email-imap")).toBe(true);
  });

  it("registering twice replaces the entry", () => {
    const a = makeStub("x");
    const b = makeStub("x");
    registerInboundConnector(a);
    registerInboundConnector(b);
    expect(getInboundConnector("x")).toBe(b);
    expect(listInboundConnectors()).toHaveLength(1);
  });

  it("unregister removes the connector", () => {
    registerInboundConnector(makeStub("a"));
    expect(unregisterInboundConnector("a")).toBe(true);
    expect(getInboundConnector("a")).toBeUndefined();
    expect(unregisterInboundConnector("a")).toBe(false);
  });

  it("listInboundConnectors returns all", () => {
    registerInboundConnector(makeStub("a"));
    registerInboundConnector(makeStub("b"));
    registerInboundConnector(makeStub("c"));
    const ids = listInboundConnectors().map((c) => c.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("rejects empty id", () => {
    expect(() =>
      registerInboundConnector({ ...makeStub(""), id: "" }),
    ).toThrow();
  });

  it("unknown id returns undefined", () => {
    expect(getInboundConnector("nope")).toBeUndefined();
    expect(hasInboundConnector("nope")).toBe(false);
  });

  it("_resetInboundRegistry empties the registry", () => {
    registerInboundConnector(makeStub("a"));
    registerInboundConnector(makeStub("b"));
    _resetInboundRegistry();
    expect(listInboundConnectors()).toHaveLength(0);
  });
});
