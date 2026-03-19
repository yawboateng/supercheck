/** @jest-environment node */

describe("location-registry helpers", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  async function loadModule(selfHosted: boolean) {
    jest.doMock("@/utils/db", () => ({
      db: {},
    }));
    jest.doMock("@/lib/feature-flags", () => ({
      isSelfHosted: () => selfHosted,
    }));

    return import("./location-registry");
  }

  it("drops hidden local restrictions in cloud mode", async () => {
    const { getVisibleProjectRestrictions } = await loadModule(false);

    expect(
      getVisibleProjectRestrictions([
        { locationId: "loc-local", code: "local" },
        { locationId: "loc-us-east", code: "us-east" },
      ])
    ).toEqual([{ locationId: "loc-us-east", code: "us-east" }]);
  });

  it("keeps local restrictions in self-hosted mode", async () => {
    const { getVisibleProjectRestrictions } = await loadModule(true);

    expect(
      getVisibleProjectRestrictions([
        { locationId: "loc-local", code: "local" },
      ])
    ).toEqual([{ locationId: "loc-local", code: "local" }]);
  });
});
