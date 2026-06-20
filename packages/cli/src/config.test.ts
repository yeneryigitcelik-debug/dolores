import { describe, expect, it } from "vitest";
import { configSchema, daemonBaseUrl, memoryContext } from "./config.js";
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
    }
  });

  it("rejects non-UUID workspaceId", () => {
    expect(configSchema.safeParse({ workspaceId: "not-a-uuid" }).success).toBe(false);
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
});

describe("daemonBaseUrl", () => {
  it("builds the correct URL from host and port", () => {
    expect(daemonBaseUrl(baseConfig)).toBe("http://127.0.0.1:4505");
  });

  it("uses custom host and port", () => {
    const config: CliConfig = { ...baseConfig, daemonHost: "myhost", daemonPort: 9000 };
    expect(daemonBaseUrl(config)).toBe("http://myhost:9000");
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
