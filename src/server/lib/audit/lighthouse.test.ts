import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: vi.fn(),
}));

vi.mock("@/server/lib/r2", () => ({
  putTextToR2: vi.fn(),
}));

vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: { getProviderSpend: vi.fn() },
}));

import { createDataforseoClient } from "@/server/lib/dataforseo";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import {
  fetchAndStoreLighthouseResult,
  selectLighthouseSample,
} from "./lighthouse";

beforeEach(() => {
  vi.mocked(AuditRepository.getProviderSpend).mockResolvedValue({
    auditUsd: 0,
    dayUsd: 0,
    monthUsd: 0,
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
  });
});
