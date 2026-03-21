import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/utils/db";
import { reports, tests, runs } from "@/db/schema";
import { getQueueEventHub, NormalizedQueueEvent } from "@/lib/queue-event-hub";
import { requireAuthContext } from "@/lib/auth-context";

const encoder = new TextEncoder();

const serialize = (payload: Record<string, unknown>) =>
  `data: ${JSON.stringify(payload)}\n\n`;

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

const terminalStatuses = new Set(["passed", "failed", "error", "completed"]);

const deriveFinalStatus = (
  queueStatus: string,
  reportStatus?: string | null
): string => {
  const normalizedQueue = queueStatus.toLowerCase();
  const normalizedReport = reportStatus?.toLowerCase?.() || null;

  // Fail-fast if either source says failed/error
  if (
    normalizedQueue === "failed" ||
    normalizedQueue === "error" ||
    normalizedReport === "failed" ||
    normalizedReport === "error"
  ) {
    return "failed";
  }

  // Only treat as passed when the report explicitly says passed
  if (normalizedReport === "passed") {
    return "passed";
  }

  // If queue claims passed but we lack report confirmation, degrade to failed-safe
  if (normalizedQueue === "passed") {
    return "failed";
  }

  // Otherwise return the queue status (running/completed/etc.)
  return normalizedQueue;
};

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

export async function GET(request: Request) {
  const url = new URL(request.url);
  const pathParts = url.pathname.split("/");
  const testId = pathParts[pathParts.length - 1];

  if (!testId) {
    return NextResponse.json({ error: "Missing testId" }, { status: 400 });
  }

  // Require authentication and project context
  let projectContext;
  try {
    projectContext = await requireAuthContext();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Check if this is a saved test OR a playground run
  // Saved tests exist in the tests table
  const test = await db.query.tests.findFirst({
    where: and(
      eq(tests.id, testId),
      eq(tests.organizationId, projectContext.organizationId),
      eq(tests.projectId, projectContext.project.id)
    ),
    columns: { id: true }
  });

  // If not a saved test, check if it's a playground run
  // Playground runs store testId in metadata.testId
  if (!test) {
    const playgroundRun = await db.query.runs.findFirst({
      where: and(
        eq(runs.projectId, projectContext.project.id),
        sql`${runs.metadata}->>'testId' = ${testId}`
      ),
      columns: { id: true }
    });

    if (!playgroundRun) {
      return NextResponse.json({ error: "Test not found or access denied" }, { status: 404 });
    }
  }

  const headers = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  };

  const stream = new ReadableStream({
    async start(controller) {
      const hub = getQueueEventHub();
      await hub.ready();

      // Track whether the stream has been closed to prevent
      // 'Controller is already closed' errors from async callbacks
      let isClosed = false;

      const safeEnqueue = (data: Uint8Array) => {
        if (isClosed) return;
        try {
          controller.enqueue(data);
        } catch {
          // Controller was closed between our check and enqueue
          isClosed = true;
        }
      };

      const send = async (event: NormalizedQueueEvent) => {
        if (isClosed) return;
        if (!shouldStreamTestStatusEvent(event, testId)) {
          return;
        }

        const status = event.status;
        let reportStatus: string | null = null;
        const payload: Record<string, unknown> = {
          status,
          derivedStatus: status,
          testId,
          queueJobId: event.queueJobId,
        };

        if (terminalStatuses.has(status)) {
          const report = await fetchEventStatusReport(
            testId,
            projectContext.project.id,
            event
          );
          if (report) {
            payload.reportPath = report.reportPath;
            payload.s3Url = report.s3Url;
            payload.reportStatus = report.status;
            reportStatus = report.status;
          }
        }

        payload.derivedStatus = deriveFinalStatus(status, reportStatus);
        safeEnqueue(encoder.encode(serialize(payload)));
      };

      const unsubscribe = hub.subscribe(send);
      safeEnqueue(encoder.encode(": connected\n\n"));

      const initialReport = await fetchInitialStatusReport(
        testId,
        projectContext.project.id
      );
      if (initialReport) {
        const initStatus = initialReport.status ?? "running";
        safeEnqueue(
          encoder.encode(
            serialize({
              status: initStatus,
              reportStatus: initStatus,
              derivedStatus: deriveFinalStatus(initStatus, initStatus),
              testId,
              reportPath: initialReport.reportPath,
              s3Url: initialReport.s3Url,
            })
          )
        );
      } else {
        safeEnqueue(
          encoder.encode(serialize({ status: "waiting", derivedStatus: "waiting", testId }))
        );
      }

      const keepAlive = setInterval(() => {
        safeEnqueue(encoder.encode(": ping\n\n"));
      }, 30000);

      const cleanup = () => {
        isClosed = true;
        clearInterval(keepAlive);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // ignore
        }
      };

      request.signal.addEventListener("abort", cleanup);
    },
  });

  return new NextResponse(stream, { headers });
}
