import type { LocationConfig } from "@/db/schema";
import {
  getAllEnabledLocationCodes,
  getDefaultLocationCodes,
  getFirstDefaultLocationCode,
  getProjectAvailableLocationCodes,
  hasProjectLocationRestrictions,
} from "@/lib/location-registry";
import { getActiveWorkerQueueNames } from "@/lib/worker-registry";

/**
 * Resolve effective monitor locations from DB, with multi-tier fallback.
 * Validates configured locations against enabled locations in the DB,
 * falling back to defaults -> all enabled -> first default location if none are valid.
 * When projectId is provided, further restricts to project-allowed locations.
 * Note: "local" location is only available in self-hosted mode.
 */
export async function resolveMonitorLocations(
  locationConfig: LocationConfig | null,
  projectId?: string
): Promise<string[]> {
  if (!locationConfig || !locationConfig.enabled) {
    return resolveDefaultMonitorLocations(projectId);
  }

  const configuredLocations = locationConfig.locations;
  if (!configuredLocations || configuredLocations.length === 0) {
    return resolveDefaultMonitorLocations(projectId);
  }

  const enabledCodes = new Set(await getAllEnabledLocationCodes());
  let validLocations = Array.from(
    new Set(configuredLocations.filter((location) => enabledCodes.has(location)))
  );

  if (projectId && validLocations.length > 0) {
    const projectCodes = new Set(await getProjectAvailableLocationCodes(projectId));
    validLocations = validLocations.filter((location) => projectCodes.has(location));
  }

  if (validLocations.length === 0) {
    throw new Error(
      `Monitor has locations explicitly configured [${configuredLocations.join(", ")}] ` +
        `but none are currently enabled${projectId ? " for this project" : ""}. ` +
        "Re-enable the locations or update the monitor's location configuration."
    );
  }

  return validLocations;
}

/**
 * Get default monitor locations with a safety fallback chain:
 * default locations -> all enabled -> first default location.
 * Note: "local" is excluded in cloud-hosted mode via location-registry filtering.
 * When projectId is provided and the project has explicit restrictions,
 * filters the resolved defaults to only project-allowed codes.
 */
export async function resolveDefaultMonitorLocations(
  projectId?: string
): Promise<string[]> {
  const defaults = await getDefaultLocationCodes();
  let resolved: string[];
  if (defaults.length > 0) {
    resolved = defaults;
  } else {
    const enabled = await getAllEnabledLocationCodes();
    if (enabled.length > 0) {
      resolved = enabled;
    } else {
      const fallback = await getFirstDefaultLocationCode();
      resolved = [fallback];
    }
  }

  if (projectId && (await hasProjectLocationRestrictions(projectId))) {
    const projectCodes = await getProjectAvailableLocationCodes(projectId);
    const filtered = resolved.filter((location) => projectCodes.includes(location));
    if (filtered.length > 0) return filtered;
    if (projectCodes.length > 0) return projectCodes;
  }

  return Array.from(new Set(resolved));
}

/**
 * Split requested monitor locations into online and skipped sets.
 * A location is considered online only when:
 * - the app currently has a BullMQ queue object for that location, and
 * - at least one worker heartbeat advertises the matching regional queue.
 */
export async function partitionMonitorLocationsByAvailability(
  requestedLocations: string[],
  availableQueueLocations: Iterable<string>,
  buildQueueName: (location: string) => string
): Promise<{ enqueuedLocations: string[]; skippedLocations: string[] }> {
  const activeQueueNames = await getActiveWorkerQueueNames().catch((error) => {
    throw new Error(
      `Unable to verify active monitor workers: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  });

  const availableQueues = new Set(availableQueueLocations);
  const enqueuedLocations: string[] = [];
  const skippedLocations: string[] = [];

  for (const location of requestedLocations) {
    const queueName = buildQueueName(location);
    if (availableQueues.has(location) && activeQueueNames.has(queueName)) {
      enqueuedLocations.push(location);
    } else {
      skippedLocations.push(location);
    }
  }

  return { enqueuedLocations, skippedLocations };
}
