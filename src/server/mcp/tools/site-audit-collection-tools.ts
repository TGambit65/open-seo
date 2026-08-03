import { z } from "zod";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import {
  AUDIT_ISSUE_TYPES,
  getIssueDescriptor,
  ISSUE_SEVERITY_ORDER,
} from "@/shared/audit-issues";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { paginateAuditRows } from "@/server/mcp/tools/audit-pagination";
import {
  auditIdSchema,
  auditPath,
  completenessFor,
  completenessOutputSchema,
  pageInfoOutputSchema,
  resolveAudit,
} from "@/server/mcp/tools/site-audit-tool-shared";

function parseJsonOrNull(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

const issuesInputSchema = {
  projectId: projectIdSchema,
  auditId: auditIdSchema,
  severity: z
    .enum(["critical", "warning", "info"])
    .optional()
    .describe("Only return issues of this severity."),
  issueType: z
    .string()
    .max(100)
    .optional()
    .describe(
      `Only return issues of this type. One of: ${Object.keys(AUDIT_ISSUE_TYPES).join(", ")}`,
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1_000)
    .optional()
    .describe("Max issues to return (default 200)."),
  cursor: z
    .string()
    .max(2_048)
    .optional()
    .describe("Opaque cursor returned by the previous page."),
} as const;

type IssuesArgs = z.infer<z.ZodObject<typeof issuesInputSchema>>;

export const getAuditIssuesTool = {
  name: "get_audit_issues",
  config: {
    title: "Get site audit issues",
    description:
      "Read the prioritized issue report from a completed site audit. Every issue carries a how_to_fix with concrete remediation steps an agent can act on. Free — reads OpenSEO state. Omit auditId for the most recent audit.",
    inputSchema: issuesInputSchema,
    outputSchema: z.object({
      summary: z.array(
        z.object({
          issueType: z.string(),
          title: z.string(),
          severity: z.enum(["critical", "warning", "info"]),
          count: z.number().int().nonnegative(),
        }),
      ),
      issues: z.array(
        z.object({
          severity: z.enum(["critical", "warning", "info"]),
          issueType: z.string(),
          title: z.string(),
          url: z.string(),
          details: z.unknown().nullable(),
          howToFix: z.string().nullable(),
        }),
      ),
      pageInfo: pageInfoOutputSchema,
      completeness: completenessOutputSchema,
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: IssuesArgs, context) => {
    const audit = await resolveAudit(args.projectId, args.auditId);
    const unsorted = await AuditRepository.getIssuesForAudit(audit.id, {
      severity: args.severity,
      issueType: args.issueType,
    });
    const rows = unsorted.toSorted(
      (left, right) =>
        ISSUE_SEVERITY_ORDER[left.severity] -
          ISSUE_SEVERITY_ORDER[right.severity] ||
        left.issueType.localeCompare(right.issueType) ||
        left.id.localeCompare(right.id),
    );

    const counts = new Map<string, number>();
    for (const row of rows) {
      counts.set(row.issueType, (counts.get(row.issueType) ?? 0) + 1);
    }
    const summary = Array.from(counts.entries())
      .map(([issueType, count]) => {
        const descriptor = getIssueDescriptor(issueType);
        return {
          issueType,
          title: descriptor?.title ?? issueType,
          severity: descriptor?.severity ?? "info",
          count,
        };
      })
      .toSorted(
        (left, right) =>
          ISSUE_SEVERITY_ORDER[left.severity] -
            ISSUE_SEVERITY_ORDER[right.severity] || right.count - left.count,
      );

    const paginated = paginateAuditRows({
      rows,
      limit: args.limit ?? 200,
      cursor: args.cursor,
      scope: JSON.stringify({
        kind: "issues",
        auditId: audit.id,
        severity: args.severity ?? null,
        issueType: args.issueType ?? null,
      }),
    });
    const issues = paginated.rows.map((row) => {
      const descriptor = getIssueDescriptor(row.issueType);
      return {
        severity: row.severity,
        issueType: row.issueType,
        title: descriptor?.title ?? row.issueType,
        url: row.pageUrl,
        details: parseJsonOrNull(row.detailsJson),
        howToFix: descriptor?.howToFix ?? null,
      };
    });

    const text =
      rows.length === 0
        ? args.severity || args.issueType
          ? `No issues found for audit ${audit.id} matching the given filters.`
          : `No issues recorded for audit ${audit.id}. Re-run the audit to produce a current report.`
        : [
            `Audit ${audit.id} (${audit.startUrl}): ${rows.length} issues${paginated.pageInfo.hasMore ? ` (showing ${paginated.pageInfo.returned})` : ""}.`,
            "By type:",
            ...summary.map(
              (entry) =>
                `- [${entry.severity}] ${entry.title} (${entry.issueType}): ${entry.count}`,
            ),
            "Full issue rows with how_to_fix instructions are in structuredContent.issues.",
          ].join("\n");

    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        auditPath(args.projectId, audit.id),
      ),
      structuredContent: {
        summary,
        issues,
        pageInfo: paginated.pageInfo,
        completeness: completenessFor(audit.status, paginated.pageInfo.hasMore),
      },
    });
  }),
};

const pagesInputSchema = {
  projectId: projectIdSchema,
  auditId: auditIdSchema,
  fetchClass: z
    .enum(["ok", "blocked", "error"])
    .optional()
    .describe(
      'Filter by fetch outcome ("blocked" = the site\'s bot protection challenged the crawler).',
    ),
  statusCode: z
    .number()
    .int()
    .optional()
    .describe("Filter by exact HTTP status code."),
  urlContains: z
    .string()
    .max(500)
    .optional()
    .describe("Filter to URLs containing this substring."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1_000)
    .optional()
    .describe("Max pages to return (default 100)."),
  cursor: z
    .string()
    .max(2_048)
    .optional()
    .describe("Opaque cursor returned by the previous page."),
} as const;

type PagesArgs = z.infer<z.ZodObject<typeof pagesInputSchema>>;

export const getAuditPagesTool = {
  name: "get_audit_pages",
  config: {
    title: "Get site audit pages",
    description:
      "List crawled pages from a site audit with per-page SEO data (status, title, description, word count, indexability, crawl depth, link counts). Free — reads OpenSEO state. Omit auditId for the most recent audit.",
    inputSchema: pagesInputSchema,
    outputSchema: z.object({
      pages: z.array(
        z.object({
          id: z.string(),
          url: z.string(),
          statusCode: z.number().int().nullable(),
          fetchClass: z.enum(["ok", "blocked", "error"]),
          redirectUrl: z.string().nullable(),
          title: z.string().nullable(),
          metaDescription: z.string().nullable(),
          wordCount: z.number().int().nonnegative(),
          isIndexable: z.boolean(),
          crawlDepth: z.number().int().nullable(),
          inSitemap: z.boolean(),
          internalLinkCount: z.number().int().nonnegative(),
          responseTimeMs: z.number().int().nullable(),
        }),
      ),
      total: z.number().int().nonnegative(),
      pageInfo: pageInfoOutputSchema,
      completeness: completenessOutputSchema,
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: PagesArgs, context) => {
    const audit = await resolveAudit(args.projectId, args.auditId);
    const allPages = await AuditRepository.getPagesForAudit(audit.id);
    const filtered = allPages
      .filter(
        (page) =>
          (!args.fetchClass || page.fetchClass === args.fetchClass) &&
          (args.statusCode === undefined ||
            page.statusCode === args.statusCode) &&
          (!args.urlContains || page.url.includes(args.urlContains)),
      )
      .toSorted(
        (left, right) =>
          left.url.localeCompare(right.url) || left.id.localeCompare(right.id),
      );
    const paginated = paginateAuditRows({
      rows: filtered,
      limit: args.limit ?? 100,
      cursor: args.cursor,
      scope: JSON.stringify({
        kind: "pages",
        auditId: audit.id,
        fetchClass: args.fetchClass ?? null,
        statusCode: args.statusCode ?? null,
        urlContains: args.urlContains ?? null,
      }),
    });
    const pages = paginated.rows;
    const text = [
      `Audit ${audit.id}: ${filtered.length} pages${paginated.pageInfo.hasMore ? ` (showing ${paginated.pageInfo.returned})` : ""}.`,
      ...pages
        .slice(0, 25)
        .map(
          (page) =>
            `- ${page.statusCode} ${page.url}${page.fetchClass !== "ok" ? ` [${page.fetchClass}]` : ""}  "${page.title ?? ""}"`,
        ),
      "Full rows are in structuredContent.pages.",
    ].join("\n");

    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        auditPath(args.projectId, audit.id),
      ),
      structuredContent: {
        pages,
        total: filtered.length,
        pageInfo: paginated.pageInfo,
        completeness: completenessFor(audit.status, paginated.pageInfo.hasMore),
      },
    });
  }),
};
