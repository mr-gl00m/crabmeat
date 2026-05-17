import { describe, it, expect, beforeEach } from "vitest";
import {
  registerOutboundConnector,
  unregisterOutboundConnector,
  getOutboundConnector,
  listOutboundConnectors,
  hasOutboundConnector,
  _resetOutboundRegistry,
  type OutboundConnector,
} from "./outbound.js";

function makeStub(id: string): OutboundConnector {
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

describe("outbound connector registry", () => {
  it("registers and retrieves a connector", () => {
    const c = makeStub("discord");
    registerOutboundConnector(c);
    expect(getOutboundConnector("discord")).toBe(c);
    expect(hasOutboundConnector("discord")).toBe(true);
  });

  it("registering twice replaces the entry", () => {
    const a = makeStub("x");
    const b = makeStub("x");
    registerOutboundConnector(a);
    registerOutboundConnector(b);
    expect(getOutboundConnector("x")).toBe(b);
    expect(listOutboundConnectors()).toHaveLength(1);
  });

  it("unregister removes the connector", () => {
    registerOutboundConnector(makeStub("a"));
    expect(unregisterOutboundConnector("a")).toBe(true);
    expect(getOutboundConnector("a")).toBeUndefined();
    expect(unregisterOutboundConnector("a")).toBe(false);
  });

  it("listOutboundConnectors returns all", () => {
    registerOutboundConnector(makeStub("a"));
    registerOutboundConnector(makeStub("b"));
    registerOutboundConnector(makeStub("c"));
    const ids = listOutboundConnectors().map((c) => c.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("rejects empty id", () => {
    expect(() =>
      registerOutboundConnector({ ...makeStub(""), id: "" }),
    ).toThrow();
  });

  it("unknown id returns undefined", () => {
    expect(getOutboundConnector("nope")).toBeUndefined();
    expect(hasOutboundConnector("nope")).toBe(false);
  });

  it("_resetOutboundRegistry empties the registry", () => {
    registerOutboundConnector(makeStub("a"));
    registerOutboundConnector(makeStub("b"));
    _resetOutboundRegistry();
    expect(listOutboundConnectors()).toHaveLength(0);
  });
});
