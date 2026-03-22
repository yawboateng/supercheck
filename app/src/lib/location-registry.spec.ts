/** @jest-environment node */

describe("location-registry helpers", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  async function loadModule(
    selfHosted: boolean,
    restrictionRows: Array<{ code: string }> = []
  ) {
    jest.doMock("@/utils/db", () => ({
      db: {
        select: jest.fn(() => ({
          from: jest.fn().mockReturnThis(),
          innerJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockResolvedValue(restrictionRows),
        })),
      },
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

  it("returns the first visible project restriction code", async () => {
    const { getFirstVisibleProjectRestrictionCode } = await loadModule(false, [
      { code: "local" },
      { code: "us-east" },
      { code: "eu-central" },
    ]);

    await expect(
      getFirstVisibleProjectRestrictionCode("project-1")
    ).resolves.toBe("us-east");
  });

  it("returns undefined when all project restrictions are hidden", async () => {
    const { getFirstVisibleProjectRestrictionCode } = await loadModule(false, [
      { code: "local" },
    ]);

    await expect(
      getFirstVisibleProjectRestrictionCode("project-1")
    ).resolves.toBeUndefined();
  });
});
