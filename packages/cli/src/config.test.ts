import { describe, expect, it } from "vitest";
import {
  configSchema,
  daemonBaseUrl,
  formatConfigIssues,
  loadConfigFromEnv,
  memoryContext,
} from "./config.js";
import type { CliConfig } from "./config.js";

const baseConfig: CliConfig = {
  workspaceId: "00000000-0000-0000-0000-000000000001",
  daemonHost: "127.0.0.1",
  daemonPort: 4505,
};

describe("configSchema", () => {
  it("defaults workspaceId to the sentinel UUID when env is empty", () => {
    const result = configSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.workspaceId).toBe("00000000-0000-0000-0000-000000000001");
      expect(result.data.authToken).toBeUndefined();
      expect(result.data.requestTimeoutMs).toBeUndefined();
    }
  });

  it("rejects non-UUID workspaceId", () => {
    expect(configSchema.safeParse({ workspaceId: "not-a-uuid" }).success).toBe(false);
  });

  it("accepts an explicit sentinel workspaceId and legacy GUID userId", () => {
    const result = configSchema.safeParse({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      userId: "11111111-1111-1111-1111-111111111111",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.workspaceId).toBe("00000000-0000-0000-0000-000000000001");
      expect(result.data.userId).toBe("11111111-1111-1111-1111-111111111111");
    }
  });

  it.each([
    ["non-hex character", "g0000000-0000-0000-0000-000000000001"],
    ["shortened group", "0000000-0000-0000-0000-000000000001"],
    ["extra hex digit", "00000000-0000-0000-0000-0000000000011"],
    ["missing hyphens", "00000000000000000000000000000001"],
  ])("rejects malformed GUID (%s) for workspaceId and userId", (_label: string, value: string) => {
    expect(configSchema.safeParse({ workspaceId: value }).success).toBe(false);
    expect(configSchema.safeParse({ userId: value }).success).toBe(false);
  });

  it("rejects daemonPort above 65535", () => {
    expect(configSchema.safeParse({ daemonPort: 99999 }).success).toBe(false);
  });

  it("rejects daemonPort of 0", () => {
    expect(configSchema.safeParse({ daemonPort: 0 }).success).toBe(false);
  });

  it("coerces string daemonPort to number", () => {
    const result = configSchema.safeParse({ daemonPort: "4505" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.daemonPort).toBe(4505);
  });

  it("accepts a valid userId UUID", () => {
    const result = configSchema.safeParse({
      userId: "11111111-1111-1111-1111-111111111111",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-UUID userId", () => {
    expect(configSchema.safeParse({ userId: "not-a-uuid" }).success).toBe(false);
  });

  it.each([
    "127.0.0.1",
    "10.0.0.5",
    "localhost",
    "dolores-daemon.internal",
    "::1",
    "[::1]",
    "fe80::1",
  ])("accepts host %s", (daemonHost) => {
    expect(configSchema.safeParse({ daemonHost }).success).toBe(true);
  });

  it.each([
    "",
    "http://localhost",
    "user:pw@localhost",
    "localhost/path",
    "localhost?x=1",
    "localhost#frag",
    "localhost:4505",
    "[::1",
    "::1]",
    "[[::1]]",
    "[127.0.0.1]",
    "300.1.1.1",
    "fe80::1%eth0",
  ])("rejects host %j", (daemonHost) => {
    expect(configSchema.safeParse({ daemonHost }).success).toBe(false);
  });
});

describe("loadConfigFromEnv", () => {
  it("uses defaults for an empty environment", () => {
    const result = loadConfigFromEnv({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.daemonHost).toBe("127.0.0.1");
      expect(result.data.daemonPort).toBe(4505);
      expect(result.data.workspaceId).toBe("00000000-0000-0000-0000-000000000001");
      expect(result.data.authToken).toBeUndefined();
    }
  });

  it("accepts legacy GUID workspace and user ids from explicit env", () => {
    const result = loadConfigFromEnv({
      DOLORES_WORKSPACE_ID: "00000000-0000-0000-0000-000000000001",
      DOLORES_USER_ID: "11111111-1111-1111-1111-111111111111",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.workspaceId).toBe("00000000-0000-0000-0000-000000000001");
      expect(result.data.userId).toBe("11111111-1111-1111-1111-111111111111");
    }
  });

  it("treats a blank token as absent and trims a real one", () => {
    const blank = loadConfigFromEnv({ DOLORES_AUTH_TOKEN: "   " });
    expect(blank.success && blank.data.authToken).toBeUndefined();
    const real = loadConfigFromEnv({ DOLORES_AUTH_TOKEN: "  tok-123 " });
    expect(real.success && real.data.authToken).toBe("tok-123");
  });

  it("parses a positive integer request timeout", () => {
    const result = loadConfigFromEnv({ DOLORES_REQUEST_TIMEOUT_MS: "250" });
    expect(result.success && result.data.requestTimeoutMs).toBe(250);
  });

  it.each(["0", "-5", "abc", "1.5", "3600001"])("rejects request timeout %j", (value) => {
    expect(loadConfigFromEnv({ DOLORES_REQUEST_TIMEOUT_MS: value }).success).toBe(false);
  });

  it("accepts a raw IPv6 host from env", () => {
    const result = loadConfigFromEnv({ DOLORES_DAEMON_HOST: "::1" });
    expect(result.success).toBe(true);
  });

  it("reports issues by env name without leaking values", () => {
    const result = loadConfigFromEnv({
      DOLORES_AUTH_TOKEN: "super-secret-token",
      DOLORES_DAEMON_PORT: "notaport",
      DOLORES_DAEMON_HOST: "http://evil.example/x",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const text = formatConfigIssues(result.error);
      expect(text).toContain("DOLORES_DAEMON_PORT");
      expect(text).toContain("DOLORES_DAEMON_HOST");
      expect(text).not.toContain("super-secret-token");
      expect(text).not.toContain("evil.example");
    }
  });
});

describe("daemonBaseUrl", () => {
  it("builds the correct URL from host and port", () => {
    expect(daemonBaseUrl(baseConfig)).toBe("http://127.0.0.1:4505");
  });

  it("uses custom host and port", () => {
    const config: CliConfig = { ...baseConfig, daemonHost: "myhost", daemonPort: 9000 };
    expect(daemonBaseUrl(config)).toBe("http://myhost:9000");
  });

  it("brackets raw and already-bracketed IPv6 exactly once", () => {
    expect(daemonBaseUrl({ ...baseConfig, daemonHost: "::1" })).toBe("http://[::1]:4505");
    expect(daemonBaseUrl({ ...baseConfig, daemonHost: "[::1]" })).toBe("http://[::1]:4505");
    expect(() => new URL(daemonBaseUrl({ ...baseConfig, daemonHost: "::1" }))).not.toThrow();
  });

  it("never embeds the token in the URL", () => {
    const url = daemonBaseUrl({ ...baseConfig, authToken: "tok-xyz" });
    expect(url).not.toContain("tok-xyz");
  });
});

describe("memoryContext", () => {
  it("propagates workspaceId and userId when both are set", () => {
    const config: CliConfig = {
      ...baseConfig,
      userId: "11111111-1111-1111-1111-111111111111",
    };
    expect(memoryContext(config)).toEqual({
      workspaceId: "00000000-0000-0000-0000-000000000001",
      userId: "11111111-1111-1111-1111-111111111111",
    });
  });

  it("returns null for userId when config has no userId", () => {
    expect(memoryContext(baseConfig).userId).toBeNull();
  });
});
