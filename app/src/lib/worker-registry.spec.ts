/** @jest-environment node */

describe("worker-registry helpers", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  async function loadModule(excludeLocal: boolean) {
    jest.doMock("@/lib/queue", () => ({
      getRedisConnection: jest.fn(),
    }));
    jest.doMock("@/lib/location-registry", () => ({
      LOCAL_LOCATION_CODE: "local",
      shouldExcludeLocal: () => excludeLocal,
    }));

    return import("./worker-registry");
  }

  it("reports unknown local workers in cloud mode", async () => {
    const { shouldReportUnregisteredWorkerLocation } = await loadModule(true);

    expect(
      shouldReportUnregisteredWorkerLocation("local", new Set(["us-east"]))
    ).toBe(true);
  });

  it("ignores local workers in self-hosted mode when local is intentionally hidden from the known set", async () => {
    const { shouldReportUnregisteredWorkerLocation } = await loadModule(false);

    expect(
      shouldReportUnregisteredWorkerLocation("local", new Set(["us-east"]))
    ).toBe(false);
  });

  it("never reports known worker locations", async () => {
    const { shouldReportUnregisteredWorkerLocation } = await loadModule(true);

    expect(
      shouldReportUnregisteredWorkerLocation("us-east", new Set(["us-east"]))
    ).toBe(false);
  });
});
