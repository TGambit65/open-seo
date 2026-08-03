import {
  customerHasManagedAccess,
  customerHasPaidPlan,
} from "@/server/billing/subscription";
import { AppError } from "@/server/lib/errors";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";

import type { AuditLimitTier } from "./audit-capacity";

// Plan-tier limits are the abuse bound in hosted mode: free accounts get one
// small audit at a time, paid keeps the full limits, and customers with no
// Autumn product at all are turned away. Self-hosted isn't gated.
export async function resolveAuditLimitTier(
  organizationId: string,
): Promise<AuditLimitTier> {
  if (!(await isHostedServerAuthMode())) return "paid";
  const [hasManagedAccess, hasPaidPlan] = await Promise.all([
    customerHasManagedAccess(organizationId),
    customerHasPaidPlan(organizationId),
  ]);
  if (!hasManagedAccess) {
    throw new AppError("PAYMENT_REQUIRED", "Subscribe to run site audits");
  }
  return hasPaidPlan ? "paid" : "free";
}
