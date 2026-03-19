/** @jest-environment node */

jest.mock("@/lib/location-registry", () => ({
  getAllEnabledLocationCodes: jest.fn(),
  getDefaultLocationCodes: jest.fn(),
  getFirstDefaultLocationCode: jest.fn(),
  getProjectAvailableLocationCodes: jest.fn(),
  hasProjectLocationRestrictions: jest.fn(),
}));

jest.mock("@/lib/worker-registry", () => ({
  getActiveWorkerQueueNames: jest.fn(),
}));

import {
  partitionMonitorLocationsByAvailability,
  resolveDefaultMonitorLocations,
  resolveMonitorLocations,
} from "./monitor-location-routing";

const locationRegistry = jest.requireMock("@/lib/location-registry") as {
  getAllEnabledLocationCodes: jest.Mock;
  getDefaultLocationCodes: jest.Mock;
  getFirstDefaultLocationCode: jest.Mock;
  getProjectAvailableLocationCodes: jest.Mock;
  hasProjectLocationRestrictions: jest.Mock;
};

const workerRegistry = jest.requireMock("@/lib/worker-registry") as {
  getActiveWorkerQueueNames: jest.Mock;
};

describe("monitor-location-routing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    locationRegistry.getAllEnabledLocationCodes.mockResolvedValue(["us-east", "eu-central"]);
    locationRegistry.getDefaultLocationCodes.mockResolvedValue(["us-east"]);
    locationRegistry.getFirstDefaultLocationCode.mockResolvedValue("us-east");
    locationRegistry.getProjectAvailableLocationCodes.mockResolvedValue(["us-east", "eu-central"]);
    locationRegistry.hasProjectLocationRestrictions.mockResolvedValue(false);
    workerRegistry.getActiveWorkerQueueNames.mockResolvedValue(
      new Set(["monitor-us-east"])
    );
  });

  it("filters explicit monitor locations against enabled and project-allowed sets", async () => {
    locationRegistry.getProjectAvailableLocationCodes.mockResolvedValue(["eu-central"]);

    const result = await resolveMonitorLocations(
      {
        enabled: true,
        locations: ["us-east", "eu-central", "eu-central"],
        threshold: 50,
        strategy: "majority",
      },
      "project-1"
    );

    expect(result).toEqual(["eu-central"]);
  });

  it("throws when explicit monitor locations are no longer valid", async () => {
    locationRegistry.getProjectAvailableLocationCodes.mockResolvedValue([]);

    await expect(
      resolveMonitorLocations(
        {
          enabled: true,
          locations: ["us-east"],
          threshold: 50,
          strategy: "majority",
        },
        "project-1"
      )
    ).rejects.toThrow(
      "Monitor has locations explicitly configured [us-east] but none are currently enabled for this project."
    );
  });

  it("falls back to project-allowed defaults when restricted", async () => {
    locationRegistry.getDefaultLocationCodes.mockResolvedValue(["us-east"]);
    locationRegistry.hasProjectLocationRestrictions.mockResolvedValue(true);
    locationRegistry.getProjectAvailableLocationCodes.mockResolvedValue(["eu-central"]);

    const result = await resolveDefaultMonitorLocations("project-1");

    expect(result).toEqual(["eu-central"]);
  });

  it("only keeps locations with both queue objects and live worker heartbeats", async () => {
    const result = await partitionMonitorLocationsByAvailability(
      ["us-east", "eu-central", "ap-south"],
      ["us-east", "eu-central"],
      (location) => `monitor-${location}`
    );

    expect(result).toEqual({
      enqueuedLocations: ["us-east"],
      skippedLocations: ["eu-central", "ap-south"],
    });
  });
});
