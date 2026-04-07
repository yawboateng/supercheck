/**
 * Monitor Scheduler Processor
 *
 * Handles scheduled monitor triggers. Monitors don't use the capacity
 * manager (they're lightweight checks), so this directly enqueues to
 * regional monitor queues.
 */

import { Job } from 'bullmq';
import crypto from 'crypto';
import {
  getQueues,
  monitorQueueName,
  queueLogger,
} from '@/lib/queue';
import type { LocationConfig, MonitorConfig, MonitoringLocation } from '@/db/schema';
import { monitors, monitorResults } from '@/db/schema';
import { db } from '@/utils/db';
import { desc, eq } from 'drizzle-orm';
import { EXECUTE_MONITOR_JOB_NAME } from './constants';
import {
  getFirstVisibleProjectRestrictionCode,
} from '@/lib/location-registry';
import {
  isMonitorLocationResolutionError,
  partitionMonitorLocationsByAvailability,
  resolveDefaultMonitorLocations,
  resolveMonitorLocations,
} from '@/lib/monitor-location-routing';

const logger = queueLogger;

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

function shouldRecordSchedulingFailure(errorMessage: string): boolean {
  return (
    errorMessage.includes('no jobs enqueued') ||
    errorMessage.includes('none of the expected locations') ||
    isMonitorLocationResolutionError(errorMessage)
  );
}

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
    // When enqueue fails because monitor locations cannot be resolved or no
    // workers are available, generate a failed MonitorResult so the monitor's
    // status reflects reality instead of falsely remaining "UP" indefinitely.
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (shouldRecordSchedulingFailure(errorMessage)) {
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
  const effectiveLocations = await resolveMonitorLocations(locationConfig, jobData.projectId);
  const expectedLocations = Array.from(new Set(effectiveLocations));

  // Create execution group ID for tracking related executions
  const executionGroupId = `${jobData.monitorId}-${Date.now()}-${crypto
    .randomBytes(4)
    .toString('hex')}`;

  // Get queue instances
  const queues = await getQueues();

  // First pass: determine which locations have active queues
  const { enqueuedLocations, skippedLocations } =
    await partitionMonitorLocationsByAvailability(
      expectedLocations,
      Object.keys(queues.monitorExecutionQueue),
      monitorQueueName
    );

  if (enqueuedLocations.length === 0 && expectedLocations.length > 0) {
    throw new Error(
      `Monitor ${jobData.monitorId}: no jobs enqueued — none of the expected locations ` +
      `[${expectedLocations.join(', ')}] have live workers. Check worker health and location configuration.`
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
      `due to missing/offline workers. Aggregation will proceed with ${enqueuedLocations.length} location(s).`
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
    // Prefer DB-validated locations, then explicit monitor locations, then
    // project restrictions (even if disabled), then unrestricted defaults, and
    // finally the last known result location.
    const monitor = await db.query.monitors.findFirst({
      where: eq(monitors.id, monitorId),
      columns: { config: true, projectId: true },
    });
    const monitorConfig = monitor?.config as MonitorConfig | null;
    const locationConfig = monitorConfig?.locationConfig as LocationConfig | null;
    const configuredLocations = locationConfig?.locations;

    // Read the latest result to maintain consecutive failure counting
    const lastResult = await db.query.monitorResults.findFirst({
      where: eq(monitorResults.monitorId, monitorId),
      orderBy: [desc(monitorResults.checkedAt)],
      columns: {
        location: true,
        isUp: true,
        consecutiveFailureCount: true,
        alertsSentForFailure: true,
      },
    });

    let location: MonitoringLocation | undefined;

    try {
      const resolvedLocations = await resolveMonitorLocations(
        locationConfig,
        monitor?.projectId ?? undefined
      );
      location = resolvedLocations[0] as MonitoringLocation | undefined;
    } catch {
      // Fall through to the configured/default/last-known fallback chain below.
    }

    if (!location && configuredLocations && configuredLocations.length > 0) {
      location = configuredLocations[0] as MonitoringLocation;
    }

    if (!location && monitor?.projectId) {
      location = (await getFirstVisibleProjectRestrictionCode(
        monitor.projectId
      )) as MonitoringLocation | undefined;
    }

    if (!location) {
      try {
        const defaultLocations = await resolveDefaultMonitorLocations(
          monitor?.projectId ?? undefined
        );
        location = defaultLocations[0] as MonitoringLocation | undefined;
      } catch {
        // Keep falling back.
      }
    }

    if (!location && lastResult?.location) {
      location = lastResult.location as MonitoringLocation;
    }

    if (!location) {
      logger.warn(
        { monitorId, errorMessage },
        "Scheduling failure — monitor marked as down without a result row because no valid location could be resolved"
      );
      return;
    }

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
