import { afterEach, describe, expect, it, vi } from "vitest";
import { runConsolidate } from "./consolidate.js";

vi.mock("../config.js", () => ({
  DEFAULT_REQUEST_TIMEOUT_MS: 60_000,
  getConfig: () => ({
    workspaceId: "11111111-1111-4111-8111-111111111111",
    daemonHost: "127.0.0.1",
    daemonPort: 4505,
  }),
  memoryContext: () => ({ workspaceId: "11111111-1111-4111-8111-111111111111" }),
  daemonBaseUrl: () => "http://127.0.0.1:4505",
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const counts = { candidates: 0, clusters: 0, consolidated: 0, superseded: 0 };
const missingCount = (key: keyof typeof counts) =>
  Object.fromEntries(Object.entries(counts).filter(([name]) => name !== key));
const invalid = [
  {},
  { enabled: "false", ...counts },
  { enabled: true },
  { enabled: null, ...counts },
  ...(["candidates", "clusters", "consolidated", "superseded"] as const).map((key) => ({
    enabled: false,
    ...missingCount(key),
  })),
  { enabled: true, ...counts, candidates: -1 },
  { enabled: true, ...counts, clusters: 1.5 },
  { enabled: true, ...counts, consolidated: Number.MAX_SAFE_INTEGER + 1 },
  { enabled: true, ...counts, superseded: "0" },
];
function response(payload: unknown) {
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", request);
  return request;
}
describe("consolidate acknowledgement truthfulness", () => {
  it.each(invalid)("rejects unverified mode/counters before any claim: %j", async (payload) => {
    const request = response({ ...payload, diagnostic: "CONSOLIDATE_ACK_SENTINEL" });
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw Error("synthetic-exit");
    });
    await expect(runConsolidate({ scope: "workspace" })).rejects.toThrow("synthetic-exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join(" ")).not.toContain("CONSOLIDATE_ACK_SENTINEL");
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({
      scope: "workspace",
    });
  });
  it.each([
    { enabled: false, ...counts },
    { enabled: true, ...counts },
    { enabled: true, candidates: 8, clusters: 2, consolidated: 2, superseded: 6 },
    { enabled: true, ...counts, candidates: Number.MAX_SAFE_INTEGER },
  ])("preserves valid disabled/enabled and exact integer counts: %j", async (payload) => {
    const request = response({ ...payload, futureField: "compatible" });
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    await runConsolidate({});
    const text = stdout.mock.calls.flat().join(" ");
    expect(text).toContain(payload.enabled ? "Consolidation tamamlandı" : "Consolidation kapalı");
    expect(text.includes("✓")).toBe(payload.enabled);
    if (payload.enabled)
      for (const value of Object.values(payload).slice(1)) expect(text).toContain(String(value));
    expect(request).toHaveBeenCalledTimes(1);
  });
});
