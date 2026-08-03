import { and, asc, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { db } from "@/db";
import {
  auditDispatchLeases,
  auditLighthouseResults,
  audits,
} from "@/db/schema";
import type { AuditConfig } from "@/server/lib/audit/types";
import { BRUTAL_AUDIT_LIMITS } from "@/shared/audit-provider";

async function createAudit(data: {
  id: string;
  projectId: string;
  startedByUserId: string;
  startUrl: string;
  workflowInstanceId: string;
  config: AuditConfig;
  pagesTotal: number;
  lighthouseTotal: number;
  origin: string;
  idempotencyKey?: string;
}) {
  const inserted = await db
    .insert(audits)
    .values({
      id: data.id,
      projectId: data.projectId,
      startedByUserId: data.startedByUserId,
      startUrl: data.startUrl,
      origin: data.origin,
      idempotencyKey: data.idempotencyKey ?? null,
      workflowInstanceId: data.workflowInstanceId,
      config: JSON.stringify(data.config),
      status: "running",
      pagesTotal: data.pagesTotal,
      lighthouseTotal: data.lighthouseTotal,
      currentPhase: "discovery",
    })
    .onConflictDoNothing()
    .returning({ id: audits.id });
  return inserted.length === 1;
}

async function findAuditByIdempotencyKey(
  projectId: string,
  idempotencyKey: string,
) {
  return db.query.audits.findFirst({
    where: and(
      eq(audits.projectId, projectId),
      eq(audits.idempotencyKey, idempotencyKey),
    ),
  });
}

async function acquireDispatchLease(auditId: string, origin: string) {
  const owned = await db.query.auditDispatchLeases.findFirst({
    where: eq(auditDispatchLeases.auditId, auditId),
  });
  if (owned) return { acquired: true as const, slot: owned.slot };

  const existingOrigin = await db.query.auditDispatchLeases.findFirst({
    where: eq(auditDispatchLeases.origin, origin),
  });
  if (existingOrigin) {
    return { acquired: false as const, reason: "origin" as const };
  }

  for (
    let slot = 1;
    slot <= BRUTAL_AUDIT_LIMITS.maxConcurrentAudits;
    slot += 1
  ) {
    const inserted = await db
      .insert(auditDispatchLeases)
      .values({ slot, auditId, origin })
      .onConflictDoNothing()
      .returning({ slot: auditDispatchLeases.slot });
    if (inserted.length === 1) return { acquired: true as const, slot };

    const wonRace = await db.query.auditDispatchLeases.findFirst({
      where: eq(auditDispatchLeases.auditId, auditId),
    });
    if (wonRace) return { acquired: true as const, slot: wonRace.slot };

    const originWonRace = await db.query.auditDispatchLeases.findFirst({
      where: eq(auditDispatchLeases.origin, origin),
    });
    if (originWonRace) {
      return { acquired: false as const, reason: "origin" as const };
    }
  }
  return { acquired: false as const, reason: "global" as const };
}

async function releaseDispatchLease(auditId: string) {
  await db
    .delete(auditDispatchLeases)
    .where(eq(auditDispatchLeases.auditId, auditId));
}

async function markWorkflowStarted(auditId: string) {
  await db
    .update(audits)
    .set({ workflowStartedAt: new Date().toISOString() })
    .where(eq(audits.id, auditId));
}

async function updateAuditProgress(
  auditId: string,
  workflowInstanceId: string,
  data: {
    pagesCrawled?: number;
    pagesTotal?: number;
    lighthouseTotal?: number;
    lighthouseCompleted?: number;
    lighthouseFailed?: number;
    currentPhase?: string;
  },
) {
  await db
    .update(audits)
    .set(data)
    .where(
      and(
        eq(audits.id, auditId),
        eq(audits.workflowInstanceId, workflowInstanceId),
      ),
    );
}

async function completeAudit(
  auditId: string,
  workflowInstanceId: string,
  data: {
    pagesCrawled: number;
    pagesTotal: number;
    crawlCompleted: boolean;
  },
) {
  const completedAt = new Date();
  const rawDeleteAfter = new Date(
    completedAt.getTime() +
      BRUTAL_AUDIT_LIMITS.rawRetentionDays * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const updated = await db
    .update(audits)
    .set({
      status: "completed",
      completedAt: completedAt.toISOString(),
      rawDeleteAfter,
      currentPhase: "completed",
      ...data,
    })
    .where(
      and(
        eq(audits.id, auditId),
        eq(audits.workflowInstanceId, workflowInstanceId),
      ),
    )
    .returning({ id: audits.id });
  if (updated.length > 0) await releaseDispatchLease(auditId);
}

async function failAudit(auditId: string, workflowInstanceId: string) {
  const updated = await db
    .update(audits)
    .set({
      status: "failed",
      completedAt: new Date().toISOString(),
      currentPhase: "failed",
    })
    .where(
      and(
        eq(audits.id, auditId),
        eq(audits.workflowInstanceId, workflowInstanceId),
        eq(audits.status, "running"),
      ),
    )
    .returning({ id: audits.id });
  if (updated.length > 0) await releaseDispatchLease(auditId);
}

async function getAuditForWorkflow(
  auditId: string,
  workflowInstanceId: string,
) {
  return db.query.audits.findFirst({
    where: and(
      eq(audits.id, auditId),
      eq(audits.workflowInstanceId, workflowInstanceId),
    ),
  });
}

async function getAuditForProject(auditId: string, projectId: string) {
  return db.query.audits.findFirst({
    where: and(eq(audits.id, auditId), eq(audits.projectId, projectId)),
  });
}

async function getLatestAuditForProject(projectId: string) {
  return db.query.audits.findFirst({
    where: eq(audits.projectId, projectId),
    orderBy: desc(audits.startedAt),
  });
}

async function getAuditsByProject(projectId: string) {
  const rows = await db
    .select({ audit: audits })
    .from(audits)
    .where(eq(audits.projectId, projectId))
    .orderBy(desc(audits.startedAt));
  return rows.map(({ audit }) => audit);
}

async function getAuditUsageForUser(userId: string) {
  const rows = await db.query.audits.findMany({
    where: eq(audits.startedByUserId, userId),
    columns: { status: true, pagesTotal: true, lighthouseTotal: true },
  });
  return {
    capacityUnits: rows.reduce(
      (total, row) => total + row.pagesTotal + row.lighthouseTotal,
      0,
    ),
    runningCount: rows.filter((row) => row.status === "running").length,
  };
}

async function deleteAuditForProject(auditId: string, projectId: string) {
  await db
    .delete(audits)
    .where(and(eq(audits.id, auditId), eq(audits.projectId, projectId)));
}

async function getRawKeysForAudit(auditId: string) {
  const rows = await db.query.auditLighthouseResults.findMany({
    where: eq(auditLighthouseResults.auditId, auditId),
    columns: { r2Key: true },
  });
  return rows.flatMap((row) => (row.r2Key ? [row.r2Key] : []));
}

async function getAuditsDueForRawDeletion(now: string, limit = 25) {
  return db.query.audits.findMany({
    where: and(lte(audits.rawDeleteAfter, now), isNull(audits.rawDeletedAt)),
    orderBy: asc(audits.rawDeleteAfter),
    limit,
  });
}

async function getProviderSpend(auditId: string, now = new Date()) {
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const [audit, monthRows] = await Promise.all([
    db.query.audits.findFirst({
      where: eq(audits.id, auditId),
      columns: { actualCostUsd: true },
    }),
    db.query.auditLighthouseResults.findMany({
      where: gte(auditLighthouseResults.createdAt, monthStart.toISOString()),
      columns: { actualCostUsd: true, createdAt: true },
    }),
  ]);
  return {
    auditUsd: audit?.actualCostUsd ?? 0,
    dayUsd: monthRows.reduce(
      (sum, row) =>
        row.createdAt >= dayStart.toISOString() ? sum + row.actualCostUsd : sum,
      0,
    ),
    monthUsd: monthRows.reduce((sum, row) => sum + row.actualCostUsd, 0),
  };
}

export const AuditRunRepository = {
  createAudit,
  findAuditByIdempotencyKey,
  acquireDispatchLease,
  releaseDispatchLease,
  markWorkflowStarted,
  updateAuditProgress,
  completeAudit,
  failAudit,
  getAuditForWorkflow,
  getAuditForProject,
  getLatestAuditForProject,
  getAuditsByProject,
  getAuditUsageForUser,
  deleteAuditForProject,
  getRawKeysForAudit,
  getAuditsDueForRawDeletion,
  getProviderSpend,
} as const;
