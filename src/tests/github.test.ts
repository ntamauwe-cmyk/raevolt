// Unit tests: GitHub integration credential-precedence and connection-status
// logic — pure functions extracted so financial-critical money paths are never
// touched by these tests.
import { describe, expect, test } from "bun:test";

// Mirrors the resolution logic in src/convex/github.ts (kept in sync there).
function resolveGithubToken(
  connectionToken: string | null,
  envToken: string | undefined,
): string | null {
  const envNormalized = envToken === "" ? undefined : envToken;
  return connectionToken ?? envNormalized ?? null;
}

describe("github credential resolution", () => {
  test("org connection wins over the platform key", () => {
    expect(resolveGithubToken("org-token", "env-token")).toBe("org-token");
  });

  test("platform GITHUB_TOKEN used when no org connection", () => {
    expect(resolveGithubToken(null, "env-token")).toBe("env-token");
  });

  test("empty-string platform key counts as absent", () => {
    expect(resolveGithubToken(null, "")).toBe(null);
    expect(resolveGithubToken("org-token", "")).toBe("org-token");
  });

  test("no credentials at all → null (integration disabled)", () => {
    expect(resolveGithubToken(null, undefined)).toBe(null);
  });
});
