/** @jest-environment node */

jest.mock("@/utils/db", () => ({
  db: {
    query: {
      projects: {
        findFirst: jest.fn(),
      },
    },
    select: jest.fn(),
    transaction: jest.fn(),
  },
}));

jest.mock("@/lib/project-context", () => ({
  requireProjectContext: jest.fn(),
}));

jest.mock("@/lib/rbac/middleware", () => ({
  hasPermission: jest.fn(),
}));

jest.mock("@/lib/location-registry", () => ({
  getVisibleProjectRestrictions: jest.fn((rows) => rows),
  invalidateLocationCache: jest.fn(),
}));

import { db } from "@/utils/db";
import { requireProjectContext } from "@/lib/project-context";
import { hasPermission } from "@/lib/rbac/middleware";
import {
  getProjectLocationRestrictions,
  setProjectLocationRestrictions,
} from "./project-locations";

const mockDb = db as jest.Mocked<typeof db>;
const mockRequireProjectContext = requireProjectContext as jest.Mock;
const mockHasPermission = hasPermission as jest.Mock;

describe("project-locations actions", () => {
  const activeProjectId = "11111111-1111-1111-1111-111111111111";
  const targetProjectId = "22222222-2222-2222-2222-222222222222";

  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireProjectContext.mockResolvedValue({
      userId: "user-1",
      organizationId: "org-1",
      project: {
        id: activeProjectId,
        name: "Active Project",
        userRole: "project_admin",
      },
    });
    mockDb.query.projects.findFirst.mockResolvedValue({ id: targetProjectId });
    mockHasPermission.mockResolvedValue(true);
  });

  it("authorizes restriction reads against the target project, not the active project", async () => {
    mockHasPermission.mockResolvedValue(false);

    const result = await getProjectLocationRestrictions(targetProjectId);

    expect(result).toEqual({
      success: false,
      error: "Insufficient permissions",
    });
    expect(mockHasPermission).toHaveBeenCalledWith("project", "view", {
      organizationId: "org-1",
      projectId: targetProjectId,
    });
  });

  it("deduplicates location IDs before validating and saving restrictions", async () => {
    const mockSelectChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue([
        { id: "loc-1", code: "us-east" },
        { id: "loc-2", code: "eu-central" },
      ]),
    };
    (mockDb.select as jest.Mock).mockReturnValue(mockSelectChain);

    const deleteWhere = jest.fn().mockResolvedValue(undefined);
    const deleteChain = {
      where: deleteWhere,
    };

    const insertedValues: Array<{ projectId: string; locationId: string }> = [];
    const insertValues = jest.fn().mockImplementation((values) => {
      insertedValues.push(...values);
      return Promise.resolve();
    });
    const insertChain = {
      values: insertValues,
    };

    (mockDb.transaction as jest.Mock).mockImplementation(async (callback) =>
      callback({
        delete: jest.fn().mockReturnValue(deleteChain),
        insert: jest.fn().mockReturnValue(insertChain),
      })
    );

    const result = await setProjectLocationRestrictions(targetProjectId, [
      "loc-1",
      "loc-1",
      "loc-2",
    ]);

    expect(result).toEqual({ success: true });
    expect(mockHasPermission).toHaveBeenCalledWith("project", "update", {
      organizationId: "org-1",
      projectId: targetProjectId,
    });
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertedValues).toEqual([
      { projectId: targetProjectId, locationId: "loc-1" },
      { projectId: targetProjectId, locationId: "loc-2" },
    ]);
  });
});
