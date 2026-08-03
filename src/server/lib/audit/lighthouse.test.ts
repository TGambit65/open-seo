import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: vi.fn(),
}));

vi.mock("@/server/lib/r2", () => ({
  putTextToR2: vi.fn(),
}));

vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: {
    getProviderSpend: vi.fn(),
    getLighthouseResultForAuditPageStrategy: vi.fn(),
  },
}));

import { createDataforseoClient } from "@/server/lib/dataforseo";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { putTextToR2 } from "@/server/lib/r2";
import { DataforseoChargedTaskError } from "@/server/lib/dataforseo/envelope";
import {
  fetchAndStoreLighthouseResult,
  selectLighthouseSample,
} from "./lighthouse";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(
    AuditRepository.getLighthouseResultForAuditPageStrategy,
  ).mockResolvedValue(undefined);
  vi.mocked(AuditRepository.getProviderSpend).mockResolvedValue({
    auditUsd: 0,
    dayUsd: 0,
    monthUsd: 0,
  });
  vi.mocked(putTextToR2).mockResolvedValue({
    key: "stored/key.json",
    sizeBytes: 100,
  });
});

describe("selectLighthouseSample", () => {
  it("includes a start page reached through a trailing-slash redirect", () => {
    const pages = [
      ...Array.from({ length: 10 }, (_, index) => ({
        url: `https://example.com/section${index}`,
        statusCode: 200,
      })),
      { url: "https://example.com/services/", statusCode: 200 },
    ];

    const selected = selectLighthouseSample(
      pages,
      "https://example.com/services",
      "auto",
    );

    expect(selected).toHaveLength(10);
    expect(selected[0]).toBe("https://example.com/services/");
  });

  it("prefers an exact start page when both slash forms return 2xx", () => {
    const selected = selectLighthouseSample(
      [
        { url: "https://example.com/services/", statusCode: 200 },
        { url: "https://example.com/services", statusCode: 200 },
      ],
      "https://example.com/services",
      "auto",
    );

    expect(selected[0]).toBe("https://example.com/services");
  });
});

describe("fetchAndStoreLighthouseResult provider budget", () => {
  it("does not dispatch a new provider request after the per-audit cap", async () => {
    const live = vi.fn();
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test double exercises only the Lighthouse section
    vi.mocked(createDataforseoClient).mockReturnValue({
      lighthouse: { live },
    } as never);
    vi.mocked(AuditRepository.getProviderSpend).mockResolvedValue({
      auditUsd: 0.25,
      dayUsd: 1,
      monthUsd: 2,
    });

    const result = await fetchAndStoreLighthouseResult({
      url: "https://example.com/",
      pageId: "page-1",
      strategy: "mobile",
      billingCustomer: {
        userId: "service",
        userEmail: "service@example.invalid",
        organizationId: "service-org",
      },
      projectId: "project-1",
      auditId: "audit-1",
    });

    expect(live).not.toHaveBeenCalled();
    expect(result.errorMessage).toBe("Provider budget exhausted");
    expect(result.actualCostUsd).toBe(0);
    expect(result.budgetExhausted).toBe(true);
    expect(AuditRepository.getProviderSpend).toHaveBeenCalledTimes(1);
  });

  it("reuses a successful persisted result without another provider call", async () => {
    const live = vi.fn();
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test double exercises only the Lighthouse section
    vi.mocked(createDataforseoClient).mockReturnValue({
      lighthouse: { live },
    } as never);
    vi.mocked(
      AuditRepository.getLighthouseResultForAuditPageStrategy,
    ).mockResolvedValue({
      id: "stored-result",
      auditId: "audit-1",
      pageId: "page-1",
      strategy: "mobile",
      performanceScore: 91,
      accessibilityScore: 98,
      bestPracticesScore: 100,
      seoScore: 95,
      lcpMs: 1_000,
      cls: 0.01,
      inpMs: 100,
      ttfbMs: 200,
      errorMessage: null,
      r2Key: "stored/key.json",
      payloadSizeBytes: 100,
      providerVersion: "persisted-v1",
      lighthouseVersion: "12.0.0",
      actualCostUsd: 0.02,
      createdAt: "2026-08-02T00:00:00.000Z",
    });

    const result = await fetchAndStoreLighthouseResult({
      url: "https://example.com/",
      pageId: "page-1",
      strategy: "mobile",
      billingCustomer: {
        userId: "service",
        userEmail: "service@example.invalid",
        organizationId: "service-org",
      },
      projectId: "project-1",
      auditId: "audit-1",
    });

    expect(result.reused).toBe(true);
    expect(result.providerVersion).toBe("persisted-v1");
    expect(live).not.toHaveBeenCalled();
    expect(AuditRepository.getProviderSpend).not.toHaveBeenCalled();
  });

  it("includes charged retry cost in a later successful result", async () => {
    vi.useFakeTimers();
    try {
      const live = vi
        .fn()
        .mockRejectedValueOnce(
          new DataforseoChargedTaskError("charged failure", {
            path: ["v3", "on_page", "lighthouse", "live"],
            costUsd: 0.01,
          }),
        )
        .mockResolvedValue({
          scores: {
            performance: 90,
            accessibility: 95,
            "best-practices": 100,
            seo: 92,
          },
          metrics: {
            largestContentfulPaint: { numericValue: 1_000 },
            cumulativeLayoutShift: { numericValue: 0.01 },
            interactionToNextPaint: { numericValue: 100 },
            serverResponseTime: { numericValue: 200 },
          },
          metadata: { lighthouseVersion: "12.0.0", cost: 0.02 },
        });
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test double exercises only the Lighthouse section
      vi.mocked(createDataforseoClient).mockReturnValue({
        lighthouse: { live },
      } as never);

      const pending = fetchAndStoreLighthouseResult({
        url: "https://example.com/",
        pageId: "page-1",
        strategy: "mobile",
        billingCustomer: {
          userId: "service",
          userEmail: "service@example.invalid",
          organizationId: "service-org",
        },
        projectId: "project-1",
        auditId: "audit-1",
      });
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result.errorMessage).toBeUndefined();
      expect(result.actualCostUsd).toBeCloseTo(0.03);
      expect(result.providerVersion).toBeTruthy();
      expect(result.lighthouseVersion).toBe("12.0.0");
      expect(AuditRepository.getProviderSpend).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
