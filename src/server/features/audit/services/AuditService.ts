import { env } from "cloudflare:workers";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { resolveAuditLimitTier } from "@/server/features/audit/services/audit-service-auth";
import {
  AUDIT_LIMITS,
  clampAuditMaxPages,
  getEstimatedAuditCapacity,
  type AuditLimitTier,
} from "@/server/features/audit/services/audit-capacity";
import { AppError } from "@/server/lib/errors";
import { AuditProgressKV } from "@/server/lib/audit/progress-kv";
import { deleteFromR2 } from "@/server/lib/r2";
import {
  parseAuditConfig,
  type AuditConfig,
  type LighthouseStrategy,
} from "@/server/lib/audit/types";
import { normalizeAndValidateStartUrl } from "@/server/lib/audit/url-policy";
import {
  AUDIT_PROVIDER_VERSION,
  BRUTAL_AUDIT_LIMITS,
} from "@/shared/audit-provider";

class AmbiguousWorkflowStartError extends Error {
  constructor(readonly cause: unknown) {
    super("Workflow start could not be confirmed.");
    this.name = "AmbiguousWorkflowStartError";
  }
}

async function startAudit(input: {
  actorUserId: string;
  billingCustomer: BillingCustomerContext;
  projectId: string;
  startUrl: string;
  maxPages?: number;
  lighthouseStrategy?: LighthouseStrategy;
  limitTier: AuditLimitTier;
  idempotencyKey?: string;
}) {
  const limits = AUDIT_LIMITS[input.limitTier];
  const maxPages = clampAuditMaxPages(input.maxPages);
  if (maxPages > limits.maxPagesPerAudit) {
    throw new AppError("AUDIT_PAGE_LIMIT_EXCEEDED");
  }

  const isServiceIntegration =
    Boolean(env.ACCESS_SERVICE_TOKEN_COMMON_NAME?.trim()) &&
    input.actorUserId === env.ACCESS_SERVICE_USER_ID?.trim();
  if (isServiceIntegration && maxPages !== BRUTAL_AUDIT_LIMITS.maxPages) {
    throw new AppError(
      "AUDIT_PAGE_LIMIT_EXCEEDED",
      `Service audits must request exactly ${BRUTAL_AUDIT_LIMITS.maxPages} pages.`,
    );
  }
  if (isServiceIntegration && !input.idempotencyKey) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Service audits require an idempotency key.",
    );
  }

  const lighthouseStrategy = input.lighthouseStrategy ?? "none";
  const reservation = getEstimatedAuditCapacity({
    maxPages,
    lighthouseStrategy,
  });

  const auditId = crypto.randomUUID();
  const config: AuditConfig = { maxPages, lighthouseStrategy };
  const startUrl = await normalizeAndValidateStartUrl(input.startUrl);
  const origin = new URL(startUrl).origin;

  if (input.idempotencyKey) {
    const existing = await AuditRepository.findAuditByIdempotencyKey(
      input.projectId,
      input.idempotencyKey,
    );
    if (existing) {
      assertIdempotentAuditMatches(existing, { startUrl, config });
      if (existing.status === "running" && !existing.workflowStartedAt) {
        await ensureAuditWorkflow({
          auditId: existing.id,
          origin,
          isServiceIntegration,
          billingCustomer: input.billingCustomer,
          projectId: input.projectId,
          startUrl,
          config,
        });
      }
      return {
        auditId: existing.id,
        idempotent: true,
        providerVersion: existing.providerVersion,
      };
    }
  }

  const inserted = await AuditRepository.createAudit({
    id: auditId,
    projectId: input.projectId,
    startedByUserId: input.actorUserId,
    startUrl,
    workflowInstanceId: auditId,
    config,
    pagesTotal: reservation.pagesTotal,
    lighthouseTotal: reservation.lighthouseTotal,
    origin,
    idempotencyKey: input.idempotencyKey,
  });

  if (!inserted && input.idempotencyKey) {
    const existing = await AuditRepository.findAuditByIdempotencyKey(
      input.projectId,
      input.idempotencyKey,
    );
    if (!existing) {
      throw new AppError("CONFLICT", "Idempotent audit start conflicted.");
    }
    assertIdempotentAuditMatches(existing, { startUrl, config });
    if (existing.status === "running" && !existing.workflowStartedAt) {
      await ensureAuditWorkflow({
        auditId: existing.id,
        origin,
        isServiceIntegration,
        billingCustomer: input.billingCustomer,
        projectId: input.projectId,
        startUrl,
        config,
      });
    }
    return {
      auditId: existing.id,
      idempotent: true,
      providerVersion: existing.providerVersion,
    };
  }
  if (!inserted) throw new AppError("CONFLICT", "Audit ID conflict.");

  try {
    // Concurrency and capacity are enforced after the insert, not before: a
    // pre-insert read is a check-then-act race, so parallel requests would all
    // pass the free tier's one-running-audit gate. Post-insert, each request
    // sees at least its own row, so at most one racer can pass; the losers
    // roll back via the catch below. Two true racers may both abort — the
    // user just retries.
    if (!isServiceIntegration) {
      const usage = await AuditRepository.getAuditUsageForUser(
        input.actorUserId,
      );
      if (usage.runningCount > limits.maxRunningAudits) {
        throw new AppError("AUDIT_ALREADY_RUNNING");
      }
      if (usage.capacityUnits > limits.maxCapacityUnits) {
        throw new AppError("AUDIT_CAPACITY_REACHED");
      }
    }

    await ensureAuditWorkflow({
      auditId,
      origin,
      isServiceIntegration,
      billingCustomer: input.billingCustomer,
      projectId: input.projectId,
      startUrl,
      config,
    });
  } catch (error) {
    // Ambiguous Workflow create responses retain the idempotent row and lease:
    // retrying the same request can reconcile the exact Workflow ID without
    // risking duplicate provider work. Definitive application/capacity errors
    // are safe to roll back because no Workflow create was attempted.
    const ambiguousStart =
      Boolean(input.idempotencyKey) &&
      error instanceof AmbiguousWorkflowStartError;
    if (ambiguousStart) throw error;

    try {
      const instance = await env.SITE_AUDIT_WORKFLOW.get(auditId);
      await instance.terminate();
    } catch {
      // The workflow may never have been created, or may already be gone.
    }

    await AuditRepository.releaseDispatchLease(auditId);
    await AuditRepository.deleteAuditForProject(auditId, input.projectId);
    throw error;
  }

  return {
    auditId,
    idempotent: false,
    providerVersion: AUDIT_PROVIDER_VERSION,
  };
}

function assertIdempotentAuditMatches(
  existing: Awaited<
    ReturnType<typeof AuditRepository.findAuditByIdempotencyKey>
  >,
  expected: { startUrl: string; config: AuditConfig },
) {
  if (!existing) throw new AppError("NOT_FOUND");
  const existingConfig = parseAuditConfig(existing.config);
  if (
    existing.startUrl !== expected.startUrl ||
    !existingConfig ||
    existingConfig.maxPages !== expected.config.maxPages ||
    existingConfig.lighthouseStrategy !== expected.config.lighthouseStrategy
  ) {
    throw new AppError(
      "CONFLICT",
      "Idempotency key was already used with different audit parameters.",
    );
  }
}

async function ensureAuditWorkflow(input: {
  auditId: string;
  origin: string;
  isServiceIntegration: boolean;
  billingCustomer: BillingCustomerContext;
  projectId: string;
  startUrl: string;
  config: AuditConfig;
}) {
  if (input.isServiceIntegration) {
    const lease = await AuditRepository.acquireDispatchLease(
      input.auditId,
      input.origin,
    );
    if (!lease.acquired) {
      throw new AppError(
        lease.reason === "origin"
          ? "AUDIT_ALREADY_RUNNING"
          : "AUDIT_CAPACITY_REACHED",
      );
    }
  }

  try {
    await env.SITE_AUDIT_WORKFLOW.create({
      id: input.auditId,
      params: {
        auditId: input.auditId,
        billingCustomer: {
          userId: input.billingCustomer.userId,
          userEmail: input.billingCustomer.userEmail,
          organizationId: input.billingCustomer.organizationId,
          projectId: input.billingCustomer.projectId,
        },
        projectId: input.projectId,
        startUrl: input.startUrl,
        config: input.config,
      },
    });
  } catch (error) {
    // A response can be lost after Cloudflare accepted create. Confirm the
    // deterministic instance ID before treating the call as failed.
    try {
      const instance = await env.SITE_AUDIT_WORKFLOW.get(input.auditId);
      await instance.status();
    } catch {
      throw new AmbiguousWorkflowStartError(error);
    }
  }
  await AuditRepository.markWorkflowStarted(input.auditId);
}

async function getStatus(auditId: string, projectId: string) {
  let audit = await AuditRepository.getAuditForProject(auditId, projectId);
  if (!audit)
    throw new AppError("NOT_FOUND", "Audit not found in this project.");

  // Self-heal audits whose workflow died without reaching the mark-failed
  // step (instance terminated, mark-failed itself failed, deploys, ...).
  // Without this they stay "running" forever and hold capacity.
  if (audit.status === "running" && audit.workflowInstanceId) {
    try {
      const instance = await env.SITE_AUDIT_WORKFLOW.get(
        audit.workflowInstanceId,
      );
      const { status } = await instance.status();
      if (status === "errored" || status === "terminated") {
        await AuditRepository.failAudit(audit.id, audit.workflowInstanceId);
        audit =
          (await AuditRepository.getAuditForProject(auditId, projectId)) ??
          audit;
      }
    } catch {
      // Instance not found or status unavailable — leave the audit as-is.
    }
  }

  return {
    id: audit.id,
    startUrl: audit.startUrl,
    status: audit.status,
    pagesCrawled: audit.pagesCrawled,
    pagesTotal: audit.pagesTotal,
    lighthouseTotal: audit.lighthouseTotal,
    lighthouseCompleted: audit.lighthouseCompleted,
    lighthouseFailed: audit.lighthouseFailed,
    currentPhase: audit.currentPhase,
    startedAt: audit.startedAt,
    completedAt: audit.completedAt,
    crawlCompleted: audit.crawlCompleted,
    providerVersion: audit.providerVersion,
    actualCostUsd: audit.actualCostUsd,
  };
}

async function getResults(auditId: string, projectId: string) {
  const { audit, pages, lighthouse, issues } =
    await AuditRepository.getAuditResultsForProject(auditId, projectId);

  if (!audit) throw new AppError("NOT_FOUND");

  const parsedConfig = parseAuditConfig(audit.config);
  if (!parsedConfig) {
    throw new AppError("INTERNAL_ERROR", "Invalid audit configuration");
  }

  return {
    audit: {
      id: audit.id,
      startUrl: audit.startUrl,
      status: audit.status,
      pagesCrawled: audit.pagesCrawled,
      pagesTotal: audit.pagesTotal,
      startedAt: audit.startedAt,
      completedAt: audit.completedAt,
      crawlCompleted: audit.crawlCompleted,
      providerVersion: audit.providerVersion,
      actualCostUsd: audit.actualCostUsd,
      config: parsedConfig,
    },
    pages,
    lighthouse,
    issues,
  };
}

async function getHistory(projectId: string) {
  const auditList = await AuditRepository.getAuditsByProject(projectId);

  return auditList.map((audit) => {
    const parsedConfig = parseAuditConfig(audit.config);
    const ranLighthouse = parsedConfig?.lighthouseStrategy !== "none";

    return {
      id: audit.id,
      startUrl: audit.startUrl,
      status: audit.status,
      pagesCrawled: audit.pagesCrawled,
      pagesTotal: audit.pagesTotal,
      ranLighthouse,
      startedAt: audit.startedAt,
      completedAt: audit.completedAt,
    };
  });
}

async function getCrawlProgress(auditId: string, projectId: string) {
  const audit = await AuditRepository.getAuditForProject(auditId, projectId);
  if (!audit) {
    throw new AppError("NOT_FOUND");
  }

  return AuditProgressKV.getCrawledUrls(auditId);
}

async function remove(auditId: string, projectId: string) {
  const audit = await AuditRepository.getAuditForProject(auditId, projectId);
  if (!audit) {
    throw new AppError("NOT_FOUND");
  }

  if (audit.status === "running") {
    if (!audit.workflowInstanceId) {
      throw new AppError(
        "CONFLICT",
        "Cannot delete a running audit without workflow context.",
      );
    }

    // A row can be "running" with no live workflow instance if a start failed
    // between the row insert and workflow creation and its rollback delete
    // also failed. Nothing to terminate then — deleting the row is the fix.
    const instance = await env.SITE_AUDIT_WORKFLOW.get(
      audit.workflowInstanceId,
    ).catch(() => null);
    try {
      await instance?.terminate();
    } catch (error) {
      // terminate() throws when the instance already reached a terminal state
      // (it completed or errored in the moment before the user hit stop). That
      // race shouldn't block deletion — re-check the live status and only fail
      // if the workflow is genuinely still running.
      const status = await instance?.status().catch(() => null);
      const stillRunning =
        status != null &&
        ["queued", "running", "paused", "waiting", "waitingForPause"].includes(
          status.status,
        );
      if (stillRunning) {
        console.error(`Failed to terminate audit workflow ${audit.id}:`, error);
        throw new AppError("CONFLICT", "Unable to stop the running audit.");
      }
    }
  }

  const rawKeys = await AuditRepository.getRawKeysForAudit(auditId);
  await deleteFromR2(rawKeys);
  await AuditRepository.deleteAuditForProject(auditId, projectId);
}

async function cleanupExpiredRawAudits(now = new Date().toISOString()) {
  const due = await AuditRepository.getAuditsDueForRawDeletion(now);
  let deleted = 0;
  let failed = 0;
  for (const audit of due) {
    try {
      const rawKeys = await AuditRepository.getRawKeysForAudit(audit.id);
      await deleteFromR2(rawKeys);
      await AuditRepository.deleteAuditForProject(audit.id, audit.projectId);
      deleted += 1;
    } catch (error) {
      failed += 1;
      console.error(
        `Failed raw audit retention cleanup for ${audit.id}:`,
        error,
      );
    }
  }
  return { considered: due.length, deleted, failed };
}

export const AuditService = {
  resolveAuditLimitTier,
  startAudit,
  getStatus,
  getCrawlProgress,
  getResults,
  getHistory,
  remove,
  cleanupExpiredRawAudits,
} as const;
