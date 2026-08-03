import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  isHosted: vi.fn(),
  hasManagedAccess: vi.fn(),
  hasPaidPlan: vi.fn(),
}));

vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: authMocks.isHosted,
}));
vi.mock("@/server/billing/subscription", () => ({
  customerHasManagedAccess: authMocks.hasManagedAccess,
  customerHasPaidPlan: authMocks.hasPaidPlan,
}));

import { resolveAuditLimitTier } from "./audit-service-auth";

describe("resolveAuditLimitTier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.isHosted.mockResolvedValue(false);
  });

  it("uses paid limits for self-hosted deployments without billing calls", async () => {
    await expect(resolveAuditLimitTier("org-1")).resolves.toBe("paid");
    expect(authMocks.hasManagedAccess).not.toHaveBeenCalled();
    expect(authMocks.hasPaidPlan).not.toHaveBeenCalled();
  });

  it("rejects hosted organizations without managed access", async () => {
    authMocks.isHosted.mockResolvedValue(true);
    authMocks.hasManagedAccess.mockResolvedValue(false);
    authMocks.hasPaidPlan.mockResolvedValue(false);

    await expect(resolveAuditLimitTier("org-1")).rejects.toMatchObject({
      code: "PAYMENT_REQUIRED",
    });
  });

  it.each([
    [false, "free"],
    [true, "paid"],
  ] as const)("maps paid-plan=%s to the %s tier", async (hasPaidPlan, tier) => {
    authMocks.isHosted.mockResolvedValue(true);
    authMocks.hasManagedAccess.mockResolvedValue(true);
    authMocks.hasPaidPlan.mockResolvedValue(hasPaidPlan);

    await expect(resolveAuditLimitTier("org-1")).resolves.toBe(tier);
    expect(authMocks.hasManagedAccess).toHaveBeenCalledWith("org-1");
    expect(authMocks.hasPaidPlan).toHaveBeenCalledWith("org-1");
  });
});
