import { detectUrlTemplate, canonicalUrlKey } from "./url-utils";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import type { LighthouseResult, LighthouseStrategy } from "./types";
import { putTextToR2 } from "@/server/lib/r2";
import { DataforseoChargedTaskError } from "@/server/lib/dataforseo/envelope";
import { AUDIT_PROVIDER_VERSION } from "@/shared/audit-provider";
import { BRUTAL_AUDIT_LIMITS } from "@/shared/audit-provider";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";

interface LighthouseSamplePage {
  url: string;
  statusCode: number;
}

function canonicalUrlKeyWithoutTrailingSlash(url: string): string {
  const parsed = new URL(canonicalUrlKey(url));
  if (parsed.pathname !== "/") {
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
  }
  return parsed.toString();
}

type LighthouseFetchResult = {
  result: LighthouseExecutionResult;
  payloadJson: string | null;
};

export type LighthouseExecutionResult = LighthouseResult & {
  budgetExhausted?: true;
  reused?: true;
};

async function fetchLighthouseResult(
  url: string,
  pageId: string,
  strategy: "mobile" | "desktop",
  billingCustomer: BillingCustomerContext,
  auditId: string,
): Promise<LighthouseFetchResult> {
  let lastError: Error | null = null;
  let chargedFailureCostUsd = 0;
  const dataforseo = createDataforseoClient(billingCustomer);
  const spend = await AuditRepository.getProviderSpend(auditId);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (
        spend.auditUsd +
          chargedFailureCostUsd +
          BRUTAL_AUDIT_LIMITS.reservedCostUsdPerLighthouseRequest >
          BRUTAL_AUDIT_LIMITS.maxCostUsdPerAudit ||
        spend.dayUsd +
          chargedFailureCostUsd +
          BRUTAL_AUDIT_LIMITS.reservedCostUsdPerLighthouseRequest >
          BRUTAL_AUDIT_LIMITS.maxCostUsdPerDay ||
        spend.monthUsd +
          chargedFailureCostUsd +
          BRUTAL_AUDIT_LIMITS.reservedCostUsdPerLighthouseRequest >
          BRUTAL_AUDIT_LIMITS.maxCostUsdPerMonth
      ) {
        return {
          result: {
            url,
            pageId,
            strategy,
            performanceScore: null,
            accessibilityScore: null,
            bestPracticesScore: null,
            seoScore: null,
            lcpMs: null,
            cls: null,
            inpMs: null,
            ttfbMs: null,
            errorMessage: "Provider budget exhausted",
            providerVersion: AUDIT_PROVIDER_VERSION,
            lighthouseVersion: null,
            actualCostUsd: chargedFailureCostUsd,
            budgetExhausted: true,
          },
          payloadJson: null,
        };
      }
      if (attempt > 0) {
        // Exponential backoff: 2s, 4s
        await new Promise((resolve) =>
          setTimeout(resolve, 2000 * Math.pow(2, attempt - 1)),
        );
      }

      const data = await dataforseo.lighthouse.live({ url, strategy });

      return {
        result: {
          url,
          pageId,
          strategy,
          performanceScore: data.scores.performance,
          accessibilityScore: data.scores.accessibility,
          bestPracticesScore: data.scores["best-practices"],
          seoScore: data.scores.seo,
          lcpMs: data.metrics.largestContentfulPaint.numericValue,
          cls: data.metrics.cumulativeLayoutShift.numericValue,
          inpMs: data.metrics.interactionToNextPaint.numericValue,
          ttfbMs: data.metrics.serverResponseTime.numericValue,
          providerVersion: AUDIT_PROVIDER_VERSION,
          lighthouseVersion: data.metadata.lighthouseVersion,
          actualCostUsd: chargedFailureCostUsd + (data.metadata.cost ?? 0),
        },
        payloadJson: JSON.stringify(data),
      };
    } catch (error) {
      if (error instanceof DataforseoChargedTaskError) {
        chargedFailureCostUsd += error.billing.costUsd;
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(
        `Lighthouse attempt ${attempt + 1} failed for ${url}:`,
        lastError.message,
      );
    }
  }

  // All retries exhausted — return null scores
  console.error(
    `Lighthouse failed after 3 attempts for ${url}:`,
    lastError?.message,
  );
  return {
    result: {
      url,
      pageId,
      strategy,
      performanceScore: null,
      accessibilityScore: null,
      bestPracticesScore: null,
      seoScore: null,
      lcpMs: null,
      cls: null,
      inpMs: null,
      ttfbMs: null,
      errorMessage: lastError?.message ?? "Lighthouse request failed",
      providerVersion: AUDIT_PROVIDER_VERSION,
      lighthouseVersion: null,
      actualCostUsd: chargedFailureCostUsd,
    },
    payloadJson: null,
  };
}

export async function fetchAndStoreLighthouseResult(input: {
  url: string;
  pageId: string;
  strategy: "mobile" | "desktop";
  billingCustomer: BillingCustomerContext;
  projectId: string;
  auditId: string;
}): Promise<LighthouseExecutionResult> {
  const existing =
    await AuditRepository.getLighthouseResultForAuditPageStrategy({
      auditId: input.auditId,
      pageId: input.pageId,
      strategy: input.strategy,
    });
  if (existing && !existing.errorMessage) {
    return {
      url: input.url,
      pageId: input.pageId,
      strategy: input.strategy,
      performanceScore: existing.performanceScore,
      accessibilityScore: existing.accessibilityScore,
      bestPracticesScore: existing.bestPracticesScore,
      seoScore: existing.seoScore,
      lcpMs: existing.lcpMs,
      cls: existing.cls,
      inpMs: existing.inpMs,
      ttfbMs: existing.ttfbMs,
      errorMessage: existing.errorMessage,
      r2Key: existing.r2Key,
      payloadSizeBytes: existing.payloadSizeBytes,
      providerVersion: existing.providerVersion,
      lighthouseVersion: existing.lighthouseVersion,
      actualCostUsd: existing.actualCostUsd,
      reused: true,
    };
  }

  const fetched = await fetchLighthouseResult(
    input.url,
    input.pageId,
    input.strategy,
    input.billingCustomer,
    input.auditId,
  );

  if (!fetched.payloadJson) {
    return fetched.result;
  }

  const key = `site-audit/${input.projectId}/${input.auditId}/${input.pageId}-${input.strategy}.json`;
  const uploaded = await putTextToR2(key, fetched.payloadJson);

  return {
    ...fetched.result,
    r2Key: uploaded.key,
    payloadSizeBytes: uploaded.sizeBytes,
  };
}

/**
 * Select which pages to run Lighthouse on, based on the chosen strategy.
 */
export function selectLighthouseSample(
  pages: LighthouseSamplePage[],
  startUrl: string,
  strategy: LighthouseStrategy,
): string[] {
  if (strategy === "none") return [];

  // Only consider pages that loaded successfully
  const validPages = pages.filter(
    (p) => p.statusCode >= 200 && p.statusCode < 300,
  );

  // strategy === "auto": homepage + 1 per URL pattern, capped at 10
  const selected = new Set<string>();

  // Always include the start URL / homepage. Prefer an exact canonical match
  // so distinct 2xx `/path` and `/path/` pages stay distinct, then tolerate a
  // trailing-slash redirect when the exact start URL was not crawled as 2xx.
  const startKey = canonicalUrlKey(startUrl);
  const startPage =
    validPages.find((p) => canonicalUrlKey(p.url) === startKey) ??
    validPages.find(
      (p) =>
        canonicalUrlKeyWithoutTrailingSlash(p.url) ===
        canonicalUrlKeyWithoutTrailingSlash(startUrl),
    );
  if (startPage) selected.add(startPage.url);

  // Group by URL template pattern
  const templateGroups = new Map<string, LighthouseSamplePage>();
  for (const page of validPages) {
    if (selected.has(page.url)) continue;
    const template = detectUrlTemplate(new URL(page.url).pathname);
    if (!templateGroups.has(template)) {
      templateGroups.set(template, page);
    }
  }

  // Add one page per template group
  for (const [, page] of templateGroups) {
    if (selected.size >= 10) break;
    selected.add(page.url);
  }

  return Array.from(selected);
}
