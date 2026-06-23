/**
 * Tests for buildUserProfilePromptSection — specifically the location
 * rendering used to resolve "in my area" / "near me" queries.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { buildUserProfilePromptSection } from "./agent-data.js";

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `crabmeat-profile-test-${randomUUID().slice(0, 8)}`);
  await mkdir(join(testDir, ".crabmeat"), { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function writeProfile(data: unknown): Promise<void> {
  await writeFile(
    join(testDir, ".crabmeat", "user_profile.json"),
    JSON.stringify(data),
    "utf-8",
  );
}

describe("buildUserProfilePromptSection — location", () => {
  it("returns empty string when no profile file exists", async () => {
    const out = await buildUserProfilePromptSection(testDir);
    expect(out).toBe("");
  });

  it("renders city/region/country joined", async () => {
    await writeProfile({
      location: { city: "Saint Marys", region: "Ohio", country: "USA" },
    });
    const out = await buildUserProfilePromptSection(testDir);
    expect(out).toContain("[USER PROFILE]");
    expect(out).toContain("Location: Saint Marys, Ohio, USA");
  });

  it("includes timezone when present", async () => {
    await writeProfile({
      location: { city: "Saint Marys", region: "Ohio", timezone: "America/New_York" },
    });
    const out = await buildUserProfilePromptSection(testDir);
    expect(out).toContain("Saint Marys, Ohio");
    expect(out).toContain("(timezone: America/New_York)");
  });

  it("instructs the model how to interpret 'in my area'", async () => {
    await writeProfile({ location: { city: "Saint Marys" } });
    const out = await buildUserProfilePromptSection(testDir);
    expect(out).toContain("in my area");
    expect(out).toContain("Do not ask them to specify it again");
  });

  it("does not surface the location header when location is empty/missing fields", async () => {
    // Empty location object — nothing to join, should not emit a "Location:" line
    await writeProfile({ location: {}, communicationStyle: "terse" });
    const out = await buildUserProfilePromptSection(testDir);
    expect(out).not.toContain("Location:");
    expect(out).toContain("Communication style: terse");
  });

  it("does not duplicate location under the unknown-keys passthrough", async () => {
    await writeProfile({ location: { city: "Saint Marys" } });
    const out = await buildUserProfilePromptSection(testDir);
    // The "extra keys" branch JSON-stringifies unknown keys; if location
    // weren't in the known set we'd see a stray `location: {"city": ...}`
    // line. Make sure that line is absent.
    expect(out).not.toMatch(/^location: \{/m);
  });
});
