/**
 * Monitor Scheduler Processor
 *
 * Handles scheduled monitor triggers. Monitors don't use the capacity
 * manager (they're lightweight checks), so this directly enqueues to
 * regional monitor queues.
 */

import { Job } from 'bullmq';
import crypto from 'crypto';
import { getQueues, queueLogger } from '@/lib/queue';
import type { LocationConfig, MonitorConfig, MonitoringLocation } from '@/db/schema';
import { monitors, monitorResults } from '@/db/schema';
import { db } from '@/utils/db';
import { and, desc, eq } from 'drizzle-orm';
import { EXECUTE_MONITOR_JOB_NAME } from './constants';
import { getDefaultLocationCodes, getAllEnabledLocationCodes, getFirstDefaultLocationCode, getProjectAvailableLocationCodes, hasProjectLocationRestrictions } from '@/lib/location-registry';

const logger = queueLogger;

/**
 * Get effective locations based on location config.
 * Validates configured locations against the DB and falls back
 * to defaults if none of the configured locations are still enabled.
 * When projectId is provided, further restricts to project-allowed locations.
 * Always returns at least one location to prevent silent monitor failures.
 */
async function getEffectiveLocations(locationConfig: LocationConfig | null, projectId?: string): Promise<string[]> {
  if (!locationConfig) {
    return getDefaultLocationsWithFallback(projectId);
  }
  
  const { locations } = locationConfig;
  if (!locations || locations.length === 0) {
    return getDefaultLocationsWithFallback(projectId);
  }
  
  // Validate configured locations against enabled locations in DB
  const enabledCodes = await getAllEnabledLocationCodes();
  let validLocations = locations.filter(l => enabledCodes.includes(l));

  // Further restrict to project-allowed locations if projectId is provided
  if (projectId && validLocations.length > 0) {
    const projectCodes = await getProjectAvailableLocationCodes(projectId);
    validLocations = validLocations.filter(l => projectCodes.includes(l));
  }

  if (validLocations.length === 0) {
    // All explicitly configured locations are disabled/deleted or restricted.
    // Throw instead of silently falling back to defaults, which would
    // execute the monitor from unintended regions and report misleading
    // latency/availability data.
    throw new Error(
      `Monitor has locations explicitly configured [${locations.join(', ')}] ` +
      `but none are currently enabled${projectId ? ' for this project' : ''}. ` +
      `Re-enable the locations or update the monitor's location configuration.`
    );
  }
  
  return validLocations;
}

/**
 * Get default location codes with a safety fallback.
 * getDefaultLocationCodes() can return [] if no location has isDefault=true.
 * When projectId is provided and the project has explicit restrictions,
 * filters the resolved defaults to only project-allowed codes.
 * This function ensures we always return at least one location.
 */
async function getDefaultLocationsWithFallback(projectId?: string): Promise<string[]> {
  const defaults = await getDefaultLocationCodes();
  let resolved: string[];
  if (defaults.length > 0) {
    resolved = defaults;
  } else {
    // No defaults — try all enabled locations
    const enabled = await getAllEnabledLocationCodes();
    if (enabled.length > 0) {
      resolved = enabled;
    } else {
      // Ultimate fallback — getFirstDefaultLocationCode() returns the first default or throws in cloud mode if none exist
      const fallback = await getFirstDefaultLocationCode();
      resolved = [fallback];
    }
  }

  // Only filter by project restrictions if the project has explicit restriction rows.
  // Without this check, getProjectAvailableLocationCodes returns ALL enabled locations
  // for unrestricted projects, which would turn single-region defaults into multi-location.
  if (projectId && await hasProjectLocationRestrictions(projectId)) {
    const projectCodes = await getProjectAvailableLocationCodes(projectId);
    const filtered = resolved.filter(l => projectCodes.includes(l));
    if (filtered.length > 0) return filtered;
    if (projectCodes.length > 0) return projectCodes;
  }

  return resolved;
}

/**
 * Monitor job data structure
 */
export interface MonitorJobData {
  monitorId: string;
  projectId?: string;
  type: 'http_request' | 'website' | 'ping_host' | 'port_check';
  target: string;
  config?: MonitorConfig;
  frequencyMinutes?: number;
  executionLocation?: MonitoringLocation;
  executionGroupId?: string;
  expectedLocations?: MonitoringLocation[];
  retryLimit?: number;
  jobData?: MonitorJobData;
}

// Job retention settings
const COMPLETED_JOB_RETENTION = { count: 500, age: 24 * 3600 };
const FAILED_JOB_RETENTION = { count: 1000, age: 7 * 24 * 3600 };

/**
 * Process a scheduled monitor trigger
 */
export async function processScheduledMonitor(
  job: Job<MonitorJobData>
): Promise<{ success: boolean }> {
  const monitorId = job.data.monitorId;

  const data = job.data;
  // Handle nested jobData structure from some trigger paths
  const executionJobData = data.jobData ?? data;
  const retryLimit = data.retryLimit || 3;

  try {
    await enqueueMonitorExecutionJobs(executionJobData, retryLimit);
  } catch (error) {
    // When enqueue fails because no workers are available, generate a failed
    // MonitorResult so the monitor's status reflects reality instead of
    // falsely remaining "UP" indefinitely.
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('no jobs enqueued') || errorMessage.includes('none of the expected locations')) {
      await recordSchedulingFailure(executionJobData.monitorId, errorMessage);
    }
    throw error; // Re-throw so BullMQ marks the scheduler job as failed
  }

  return { success: true };
}

/**
 * Enqueue monitor execution jobs to regional queues
 */
async function enqueueMonitorExecutionJobs(
  jobData: MonitorJobData,
  retryLimit: number
): Promise<void> {
  const monitorConfig = jobData.config;
  const locationConfig = monitorConfig?.locationConfig as LocationConfig | null ?? null;

  // Get effective locations (multi-location monitoring) - now async
  const effectiveLocations = await getEffectiveLocations(locationConfig, jobData.projectId);
  const expectedLocations = Array.from(new Set(effectiveLocations));

  // Create execution group ID for tracking related executions
  const executionGroupId = `${jobData.monitorId}-${Date.now()}-${crypto
    .randomBytes(4)
    .toString('hex')}`;

  // Get queue instances
  const queues = await getQueues();

  // First pass: determine which locations have active queues
  const enqueuedLocations: string[] = [];
  const skippedLocations: string[] = [];

  for (const location of expectedLocations) {
    const queue = queues.monitorExecutionQueue[location];
    if (queue) {
      enqueuedLocations.push(location);
    } else {
      skippedLocations.push(location);
      logger.warn(
        { location, monitorId: jobData.monitorId },
        `No monitor queue for location "${location}", skipping`
      );
    }
  }

  if (enqueuedLocations.length === 0 && expectedLocations.length > 0) {
    throw new Error(
      `Monitor ${jobData.monitorId}: no jobs enqueued — none of the expected locations ` +
      `[${expectedLocations.join(', ')}] have active queues. Check location configuration.`
    );
  }

  if (skippedLocations.length > 0) {
    logger.warn(
      {
        monitorId: jobData.monitorId,
        skippedLocations,
        enqueuedLocations,
        executionGroupId,
      },
      `Monitor ${jobData.monitorId}: ${skippedLocations.length} location(s) skipped ` +
      `due to missing queues. Aggregation will proceed with ${enqueuedLocations.length} location(s).`
    );
  }

  // Second pass: enqueue jobs to available locations.
  // Use enqueuedLocations (not the full expectedLocations) so the worker
  // aggregation count matches actual workers and doesn't stall waiting for
  // locations that have no DB result row.
  await Promise.all(
    enqueuedLocations.map((location) => {
      const queue = queues.monitorExecutionQueue[location]!;

      return queue.add(
        EXECUTE_MONITOR_JOB_NAME,
        {
          ...jobData,
          executionLocation: location,
          executionGroupId,
          expectedLocations: enqueuedLocations,
        },
        {
          jobId: `${jobData.monitorId}:${executionGroupId}:${location}`,
          attempts: retryLimit,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: COMPLETED_JOB_RETENTION,
          removeOnFail: FAILED_JOB_RETENTION,
          priority: 10,
        }
      );
    })
  );
  // INFO logging removed to reduce log pollution - monitors trigger very frequently
}

/**
 * Mark a monitor as DOWN when the scheduler cannot enqueue execution jobs.
 *
 * In addition to updating the monitor status, we insert a monitor_results row
 * for the monitor's first configured location. This preserves consecutive
 * failure counting so that alert evaluation (threshold checks, notifications)
 * works correctly when workers recover. Without the result row, failure
 * thresholds would never increment during a queue outage and the first alert
 * would be delayed until N real failures accumulate after recovery.
 *
 * We use the monitor's actual configured location (not a synthetic
 * 'scheduler' location) to avoid polluting location-scoped queries.
 */
async function recordSchedulingFailure(
  monitorId: string,
  errorMessage: string
): Promise<void> {
  try {
    const now = new Date();

    // Update monitor status
    await db
      .update(monitors)
      .set({
        status: 'down',
        lastCheckAt: now,
        updatedAt: now,
      })
      .where(eq(monitors.id, monitorId));

    // Determine a real location for the result row.
    // Use the monitor's configured locations so we don't introduce a bogus region.
    const monitor = await db.query.monitors.findFirst({
      where: eq(monitors.id, monitorId),
      columns: { config: true },
    });
    const monitorConfig = monitor?.config as MonitorConfig | null;
    const locationConfig = monitorConfig?.locationConfig as LocationConfig | null;
    const configuredLocations = locationConfig?.locations;
    const location: MonitoringLocation = (configuredLocations && configuredLocations.length > 0
      ? configuredLocations[0]
      : 'local') as MonitoringLocation;

    // Read the latest result to maintain consecutive failure counting
    const lastResult = await db.query.monitorResults.findFirst({
      where: eq(monitorResults.monitorId, monitorId),
      orderBy: [desc(monitorResults.checkedAt)],
      columns: {
        isUp: true,
        consecutiveFailureCount: true,
        alertsSentForFailure: true,
      },
    });

    const consecutiveFailureCount = lastResult && !lastResult.isUp
      ? (lastResult.consecutiveFailureCount ?? 0) + 1
      : 1;
    const alertsSentForFailure = lastResult && !lastResult.isUp
      ? (lastResult.alertsSentForFailure ?? 0)
      : 0;
    const isStatusChange = lastResult ? lastResult.isUp : true;

    await db.insert(monitorResults).values({
      monitorId,
      checkedAt: now,
      location,
      status: 'error',
      isUp: false,
      isStatusChange,
      consecutiveFailureCount,
      consecutiveSuccessCount: 0,
      alertsSentForFailure,
      alertsSentForRecovery: 0,
      details: {
        errorMessage: `Scheduling failure: ${errorMessage}`,
      },
    });

    logger.warn(
      { monitorId, errorMessage, consecutiveFailureCount },
      `Scheduling failure — monitor marked as down with result row (location=${location})`
    );
  } catch (err) {
    logger.error(
      { monitorId, err },
      'Failed to record scheduling failure'
    );
  }
}

