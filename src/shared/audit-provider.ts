export const AUDIT_PROVIDER_VERSION = "open-seo-audit-v1";

export const BRUTAL_AUDIT_LIMITS = {
  maxPages: 50,
  maxLighthousePages: 10,
  maxConcurrentAudits: 2,
  maxConcurrentAuditsPerOrigin: 1,
  rawRetentionDays: 7,
  maxCostUsdPerAudit: 0.25,
  maxCostUsdPerDay: 10,
  maxCostUsdPerMonth: 100,
  // Conservative reservation before each provider request. Twenty maximum
  // Lighthouse requests fit exactly inside the per-audit cap.
  reservedCostUsdPerLighthouseRequest: 0.0125,
} as const;
