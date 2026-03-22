import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/utils/db";
import { reports, runs } from "@/db/schema";
import type { NormalizedQueueEvent } from "@/lib/queue-event-hub";

type StatusReportEntityType = "test" | "k6_test";

function buildReportQuery(entityType: StatusReportEntityType, entityId: string) {
  return db.query.reports.findFirst({
    where: and(
      eq(reports.entityType, entityType),
      eq(reports.entityId, entityId)
    ),
  });
}

export async function fetchEventStatusReport(
  testId: string,
  projectId: string,
  event: Pick<NormalizedQueueEvent, "category" | "queueJobId">
) {
  if (event.category === "job") {
    // K6 single-test reports are stored against the run ID, not the test ID.
    const matchingRun = await db.query.runs.findFirst({
      where: and(
        eq(runs.id, event.queueJobId),
        eq(runs.projectId, projectId),
        sql`${runs.metadata}->>'testId' = ${testId}`
      ),
      columns: { id: true },
    });

    if (!matchingRun) {
      return null;
    }

    return buildReportQuery("k6_test", matchingRun.id);
  }

  return buildReportQuery("test", testId);
}

export async function fetchInitialStatusReport(
  testId: string,
  projectId: string
) {
  const playwrightReport = await buildReportQuery("test", testId);
  if (playwrightReport) {
    return playwrightReport;
  }

  const latestK6Run = await db.query.runs.findFirst({
    where: and(
      eq(runs.projectId, projectId),
      sql`${runs.metadata}->>'testId' = ${testId}`
    ),
    orderBy: [desc(runs.createdAt)],
    columns: { id: true },
  });

  if (!latestK6Run) {
    return null;
  }

  return buildReportQuery("k6_test", latestK6Run.id);
}

export function shouldStreamTestStatusEvent(
  event: Pick<NormalizedQueueEvent, "category" | "entityId" | "queueJobId">,
  testId: string
): boolean {
  if (event.category === "test") {
    return (event.entityId ?? event.queueJobId) === testId;
  }

  // K6 single-test executions use the K6 queues, which are normalized as
  // "job" events. Only accept those when normalizeEvent resolved the real
  // test ID into entityId to avoid accidentally streaming unrelated jobs.
  if (event.category === "job") {
    return event.entityId === testId;
  }

  return false;
}
