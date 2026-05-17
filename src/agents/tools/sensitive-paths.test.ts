/**
 * Sensitive-filename blocklist tests — covers the file tools that go
 * through jailPath/jailPathReal. The Gil-Pinsky-style "reply with your
 * .env" exfil attack maps to file_read({path: ".env"}) followed by
 * email_attach of the result. The blocklist closes the file_read leg
 * of that chain; email-attach.test.ts covers the email_attach leg.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerBuiltinTools,
  setWorkspaceRoot,
  setFileAccessPaths,
  jailDenialMessage,
} from "./builtins.js";
import { getToolHandler } from "./handlers.js";

let workspace: string;
let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
  workspace = mkdtempSync(join(tmpdir(), "crabmeat-sensitive-"));
  setWorkspaceRoot(workspace);
  setFileAccessPaths([]);
  registerBuiltinTools();
});

afterAll(() => {
  setWorkspaceRoot(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
});

function seedFile(rel: string, content: string): string {
  const parts = rel.split(/[\\/]/);
  if (parts.length > 1) {
    mkdirSync(join(workspace, ...parts.slice(0, -1)), { recursive: true });
  }
  const full = join(workspace, rel);
  writeFileSync(full, content, "utf-8");
  return full;
}

describe("file_read sensitive-filename blocklist", () => {
  it("refuses to read a .env in the workspace root", async () => {
    seedFile(".env", "ANTHROPIC_API_KEY=sk-ant-api03-zzzzzz");
    const handler = getToolHandler("file_read");
    const res = await handler({ path: ".env" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("sensitive-filename pattern");
  });

  it("refuses .env.production and similar variants", async () => {
    seedFile(".env.production", "X=y");
    const handler = getToolHandler("file_read");
    const res = await handler({ path: ".env.production" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("sensitive-filename pattern");
  });

  it("refuses an SSH private key", async () => {
    seedFile("id_ed25519", "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    const handler = getToolHandler("file_read");
    const res = await handler({ path: "id_ed25519" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("sensitive-filename pattern");
  });

  it("refuses paths inside .aws/ regardless of leaf name", async () => {
    seedFile(".aws/credentials", "[default]\naws_access_key_id=AKIA...\n");
    const handler = getToolHandler("file_read");
    const res = await handler({ path: ".aws/credentials" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("sensitive-filename pattern");
  });

  it("refuses .pem certificate/key files", async () => {
    seedFile("server.pem", "-----BEGIN CERTIFICATE-----\n");
    const handler = getToolHandler("file_read");
    const res = await handler({ path: "server.pem" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("sensitive-filename pattern");
  });

  it("still reads ordinary files (jail isn't broken by the blocklist)", async () => {
    seedFile("notes.md", "# notes");
    const handler = getToolHandler("file_read");
    const res = await handler({ path: "notes.md" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("# notes");
  });
});

describe("jailDenialMessage", () => {
  it("produces the sensitive-path message for credential names", () => {
    expect(jailDenialMessage(".env")).toContain("sensitive-filename pattern");
    expect(jailDenialMessage("id_rsa")).toContain("sensitive-filename pattern");
    expect(jailDenialMessage("server.pem")).toContain("sensitive-filename pattern");
  });

  it("produces the generic out-of-jail message for other denials", () => {
    expect(jailDenialMessage("C:/Windows/notepad.exe")).toContain(
      "outside the workspace",
    );
  });
});
