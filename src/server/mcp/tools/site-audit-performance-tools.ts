import { z } from "zod";
import { AuditService } from "@/server/features/audit/services/AuditService";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import {
  auditIdSchema,
  auditPath,
  resolveAudit,
} from "@/server/mcp/tools/site-audit-tool-shared";

const metricOutputSchema = z.object({
  median: z.number().nullable(),
  worst: z.number().nullable(),
});

const deviceOutputSchema = z.object({
  attempted: z.number().int().nonnegative(),
  sampleCount: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  medianScores: z.object({
    performance: z.number().nullable(),
    accessibility: z.number().nullable(),
    bestPractices: z.number().nullable(),
    seo: z.number().nullable(),
  }),
  metrics: z.object({
    lcpMs: metricOutputSchema,
    cls: metricOutputSchema,
    inpMs: metricOutputSchema,
    ttfbMs: metricOutputSchema,
  }),
});

const performanceInputSchema = {
  projectId: projectIdSchema,
  auditId: auditIdSchema,
} as const;

type PerformanceArgs = z.infer<z.ZodObject<typeof performanceInputSchema>>;

function median(values: Array<number | null>): number | null {
  const present = values
    .filter((value): value is number => value !== null)
    .toSorted((left, right) => left - right);
  if (present.length === 0) return null;
  const middle = Math.floor(present.length / 2);
  return present.length % 2 === 1
    ? present[middle]
    : (present[middle - 1] + present[middle]) / 2;
}

function worst(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? Math.max(...present) : null;
}

type PerformanceRow = {
  performanceScore: number | null;
  accessibilityScore: number | null;
  bestPracticesScore: number | null;
  seoScore: number | null;
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  ttfbMs: number | null;
  errorMessage: string | null;
};

function summarizeDevice(rows: PerformanceRow[]) {
  const successful = rows.filter((row) => !row.errorMessage);
  const metric = (select: (row: PerformanceRow) => number | null) => ({
    median: median(successful.map(select)),
    worst: worst(successful.map(select)),
  });
  return {
    attempted: rows.length,
    sampleCount: successful.length,
    failures: rows.length - successful.length,
    medianScores: {
      performance: median(successful.map((row) => row.performanceScore)),
      accessibility: median(successful.map((row) => row.accessibilityScore)),
      bestPractices: median(successful.map((row) => row.bestPracticesScore)),
      seo: median(successful.map((row) => row.seoScore)),
    },
    metrics: {
      lcpMs: metric((row) => row.lcpMs),
      cls: metric((row) => row.cls),
      inpMs: metric((row) => row.inpMs),
      ttfbMs: metric((row) => row.ttfbMs),
    },
  };
}

export const getAuditPerformanceTool = {
  name: "get_audit_performance",
  config: {
    title: "Get site audit performance",
    description:
      "Read mobile and desktop Lighthouse samples, median scores, median/worst Core Web Vitals, failures, provider version, and actual provider cost for an audit.",
    inputSchema: performanceInputSchema,
    outputSchema: z.object({
      providerVersion: z.string(),
      actualCostUsd: z.number().nonnegative(),
      mobile: deviceOutputSchema,
      desktop: deviceOutputSchema,
      rows: z.array(
        z.object({
          url: z.string(),
          strategy: z.enum(["mobile", "desktop"]),
          performanceScore: z.number().nullable(),
          accessibilityScore: z.number().nullable(),
          bestPracticesScore: z.number().nullable(),
          seoScore: z.number().nullable(),
          lcpMs: z.number().nullable(),
          cls: z.number().nullable(),
          inpMs: z.number().nullable(),
          ttfbMs: z.number().nullable(),
          failure: z.string().nullable(),
          providerVersion: z.string(),
          lighthouseVersion: z.string().nullable(),
          actualCostUsd: z.number().nonnegative(),
        }),
      ),
      completeness: z.object({
        auditComplete: z.boolean(),
        lighthouseComplete: z.boolean(),
        partialFailures: z.boolean(),
      }),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: PerformanceArgs, context) => {
    const audit = await resolveAudit(args.projectId, args.auditId);
    const results = await AuditService.getResults(audit.id, args.projectId);
    const urlByPageId = new Map(
      results.pages.map((page) => [page.id, page.url]),
    );
    const rows = results.lighthouse.map((row) => ({
      url: urlByPageId.get(row.pageId) ?? results.audit.startUrl,
      strategy: row.strategy,
      performanceScore: row.performanceScore,
      accessibilityScore: row.accessibilityScore,
      bestPracticesScore: row.bestPracticesScore,
      seoScore: row.seoScore,
      lcpMs: row.lcpMs,
      cls: row.cls,
      inpMs: row.inpMs,
      ttfbMs: row.ttfbMs,
      failure: row.errorMessage?.slice(0, 500) ?? null,
      providerVersion: row.providerVersion,
      lighthouseVersion: row.lighthouseVersion,
      actualCostUsd: row.actualCostUsd,
    }));
    const mobileRows = results.lighthouse.filter(
      (row) => row.strategy === "mobile",
    );
    const desktopRows = results.lighthouse.filter(
      (row) => row.strategy === "desktop",
    );
    const auditComplete = audit.status !== "running";
    const lighthouseComplete =
      auditComplete &&
      audit.lighthouseCompleted + audit.lighthouseFailed >=
        audit.lighthouseTotal;

    return mcpResponse({
      text: `Audit ${audit.id}: ${rows.length} Lighthouse rows, ${audit.lighthouseFailed} failures, actual provider cost $${audit.actualCostUsd.toFixed(4)}.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        auditPath(args.projectId, audit.id),
      ),
      structuredContent: {
        providerVersion: audit.providerVersion,
        actualCostUsd: audit.actualCostUsd,
        mobile: summarizeDevice(mobileRows),
        desktop: summarizeDevice(desktopRows),
        rows,
        completeness: {
          auditComplete,
          lighthouseComplete,
          partialFailures: audit.lighthouseFailed > 0,
        },
      },
    });
  }),
};

const deleteInputSchema = {
  projectId: projectIdSchema,
  auditId: z.string().min(1).describe("Audit ID to permanently delete."),
} as const;

type DeleteArgs = z.infer<z.ZodObject<typeof deleteInputSchema>>;

export const deleteSiteAuditTool = {
  name: "delete_site_audit",
  config: {
    title: "Delete site audit",
    description:
      "Delete an audit and its raw Lighthouse objects. Raw audits are also removed automatically after the retention window.",
    inputSchema: deleteInputSchema,
    outputSchema: z.object({
      deleted: z.literal(true),
      auditId: z.string(),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: true,
    },
  },
  handler: withMcpProjectAuth(async (args: DeleteArgs, context) => {
    await AuditService.remove(args.auditId, args.projectId);
    return mcpResponse({
      text: `Audit ${args.auditId} and its raw results were deleted.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/audit`,
      ),
      structuredContent: { deleted: true, auditId: args.auditId },
    });
  }),
};
