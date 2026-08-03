import { z } from "zod";
import { AuditService } from "@/server/features/audit/services/AuditService";
import { AppError } from "@/server/lib/errors";
import { captureServerEvent } from "@/server/lib/posthog";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import {
  auditIdSchema,
  auditPath,
  resolveAudit,
} from "@/server/mcp/tools/site-audit-tool-shared";
import { AUDIT_PROVIDER_VERSION } from "@/shared/audit-provider";

const runInputSchema = {
  projectId: projectIdSchema,
  url: z.string().min(1).max(2048).describe("Start URL to crawl."),
  maxPages: z
    .number()
    .int()
    .min(10)
    .max(10_000)
    .optional()
    .describe("Page budget for the crawl (default 50)."),
  runLighthouse: z
    .boolean()
    .optional()
    .describe(
      "Run Lighthouse on a sample of up to 10 representative pages (default false).",
    ),
  idempotencyKey: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .optional()
    .describe(
      "Stable caller-generated key. Repeating the same key and parameters returns the same audit.",
    ),
} as const;

type RunArgs = z.infer<z.ZodObject<typeof runInputSchema>>;

export const runSiteAuditTool = {
  name: "run_site_audit",
  config: {
    title: "Run site audit",
    description:
      "Start a site audit: crawls the site (robots.txt-aware, same-origin), checks every page for SEO issues (broken links, duplicate/missing titles and descriptions, redirect chains, orphan pages, canonical problems, thin content, and more), and optionally runs Lighthouse on a sample of pages. Runs in the background — poll get_audit_status, then read get_audit_issues. If the site blocks our crawler, pages are honestly flagged as blocked rather than misreported.",
    inputSchema: runInputSchema,
    outputSchema: z
      .object({
        auditId: z.string(),
        idempotent: z.boolean(),
        providerVersion: z.string(),
        ...optionalMetaOutputSchema,
      })
      .strict(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: RunArgs, context) => {
    const lighthouseStrategy = (args.runLighthouse ?? false) ? "auto" : "none";
    const limitTier = await AuditService.resolveAuditLimitTier(
      context.auth.organizationId,
    );
    let auditId: string;
    let idempotent: boolean;
    try {
      ({ auditId, idempotent } = await AuditService.startAudit({
        actorUserId: context.auth.userId,
        billingCustomer: context.billing,
        projectId: args.projectId,
        startUrl: args.url,
        maxPages: args.maxPages,
        lighthouseStrategy,
        limitTier,
        idempotencyKey: args.idempotencyKey,
      }));
    } catch (error) {
      if (
        error instanceof AppError &&
        error.code === "AUDIT_CAPACITY_REACHED"
      ) {
        return mcpResponse({
          text: "Audit capacity reached for this account — delete old audits in the dashboard to free capacity, then try again.",
          meta: buildProjectMeta(
            context,
            args.projectId,
            `/p/${args.projectId}/audit`,
          ),
        });
      }
      throw error;
    }

    await captureServerEvent({
      distinctId: context.auth.userId,
      event: "site_audit:start",
      organizationId: context.auth.organizationId,
      properties: {
        project_id: args.projectId,
        max_pages: args.maxPages ?? 50,
        run_lighthouse: lighthouseStrategy !== "none",
        idempotent,
        source: "mcp",
      },
    });

    return mcpResponse({
      text: `Audit ${auditId} started for ${args.url}. Poll get_audit_status until it completes, then call get_audit_issues for the prioritized issue report.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        auditPath(args.projectId, auditId),
      ),
      structuredContent: {
        auditId,
        idempotent,
        providerVersion: AUDIT_PROVIDER_VERSION,
      },
    });
  }),
};

const statusInputSchema = {
  projectId: projectIdSchema,
  auditId: auditIdSchema,
} as const;

type StatusArgs = z.infer<z.ZodObject<typeof statusInputSchema>>;

export const getAuditStatusTool = {
  name: "get_audit_status",
  config: {
    title: "Get site audit status",
    description:
      "Check the progress of a site audit (phase, pages crawled, Lighthouse progress). Free — reads OpenSEO state. Omit auditId for the most recent audit.",
    inputSchema: statusInputSchema,
    outputSchema: z.object({
      status: z.object({
        id: z.string(),
        startUrl: z.string(),
        status: z.enum(["running", "completed", "failed"]),
        pagesCrawled: z.number().int().nonnegative(),
        pagesTotal: z.number().int().nonnegative(),
        lighthouseTotal: z.number().int().nonnegative(),
        lighthouseCompleted: z.number().int().nonnegative(),
        lighthouseFailed: z.number().int().nonnegative(),
        currentPhase: z.string().nullable(),
        startedAt: z.string(),
        completedAt: z.string().nullable(),
        crawlCompleted: z.boolean(),
        providerVersion: z.string(),
        actualCostUsd: z.number().nonnegative(),
      }),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: StatusArgs, context) => {
    const auditId = args.auditId ?? (await resolveAudit(args.projectId)).id;
    const status = await AuditService.getStatus(auditId, args.projectId);
    const lighthouseNote =
      status.lighthouseTotal > 0
        ? `, lighthouse ${status.lighthouseCompleted + status.lighthouseFailed}/${status.lighthouseTotal}`
        : "";
    return mcpResponse({
      text: `Audit ${status.id} (${status.startUrl}): ${status.status} — phase ${status.currentPhase}, ${status.pagesCrawled}/${status.pagesTotal} pages${lighthouseNote}.${status.status === "completed" ? " Call get_audit_issues for the issue report." : ""}`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        auditPath(args.projectId, status.id),
      ),
      structuredContent: { status },
    });
  }),
};
