import { beforeEach, describe, expect, it, vi } from "vitest";

const workflowMocks = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  status: vi.fn(),
  terminate: vi.fn(),
}));

const repositoryMocks = vi.hoisted(() => ({
  findAuditByIdempotencyKey: vi.fn(),
  createAudit: vi.fn(),
  acquireDispatchLease: vi.fn(),
  releaseDispatchLease: vi.fn(),
  markWorkflowStarted: vi.fn(),
  getAuditUsageForUser: vi.fn(),
  deleteAuditForProject: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    ACCESS_SERVICE_TOKEN_COMMON_NAME: "brutal-client.access",
    ACCESS_SERVICE_USER_ID: "brutal-service",
    SITE_AUDIT_WORKFLOW: {
      create: workflowMocks.create,
      get: workflowMocks.get,
    },
  },
}));

vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: repositoryMocks,
}));
vi.mock("@/server/lib/audit/url-policy", () => ({
  normalizeAndValidateStartUrl: vi.fn(async (url: string) => url),
}));
vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: vi.fn(async () => false),
}));
vi.mock("@/server/billing/subscription", () => ({
  customerHasManagedAccess: vi.fn(),
  customerHasPaidPlan: vi.fn(),
}));
vi.mock("@/server/lib/audit/progress-kv", () => ({
  AuditProgressKV: { getCrawledUrls: vi.fn(), clear: vi.fn() },
}));
vi.mock("@/server/lib/r2", () => ({ deleteFromR2: vi.fn() }));

import { AuditService } from "./AuditService";

const billingCustomer = {
  userId: "brutal-service",
  userEmail: "service@example.invalid",
  organizationId: "brutal-org",
  projectId: "project-1",
};

type CreateAuditInput = {
  id: string;
  projectId: string;
  startedByUserId: string;
  startUrl: string;
  workflowInstanceId: string;
  config: { maxPages: number; lighthouseStrategy: "auto" | "none" };
  pagesTotal: number;
  lighthouseTotal: number;
  origin: string;
  idempotencyKey?: string;
};

function startInput(overrides: Record<string, unknown> = {}) {
  return {
    actorUserId: "brutal-service",
    billingCustomer,
    projectId: "project-1",
    startUrl: "https://example.com/",
    maxPages: 50,
    lighthouseStrategy: "auto" as const,
    limitTier: "paid" as const,
    idempotencyKey: "roast:123",
    ...overrides,
  };
}

describe("AuditService.startAudit idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workflowMocks.get.mockReturnValue({
      status: workflowMocks.status,
      terminate: workflowMocks.terminate,
    });
    workflowMocks.status.mockResolvedValue({ status: "running" });
    workflowMocks.create.mockResolvedValue(undefined);
    repositoryMocks.acquireDispatchLease.mockResolvedValue({
      acquired: true,
      slot: 1,
    });
    repositoryMocks.getAuditUsageForUser.mockResolvedValue({
      runningCount: 1,
      capacityUnits: 70,
    });
    repositoryMocks.deleteAuditForProject.mockResolvedValue(undefined);
    repositoryMocks.releaseDispatchLease.mockResolvedValue(undefined);
  });

  it("returns the same audit and starts exactly one Workflow for duplicate calls", async () => {
    let stored: Record<string, unknown> | undefined;
    repositoryMocks.findAuditByIdempotencyKey.mockImplementation(
      async () => stored,
    );
    repositoryMocks.createAudit.mockImplementation(
      async (data: CreateAuditInput) => {
        stored = {
          ...data,
          status: "running",
          workflowStartedAt: null,
          providerVersion: "persisted-v1",
          config: JSON.stringify(data.config),
        };
        return true;
      },
    );
    repositoryMocks.markWorkflowStarted.mockImplementation(async () => {
      if (stored) stored.workflowStartedAt = new Date().toISOString();
    });

    const first = await AuditService.startAudit(startInput());
    const second = await AuditService.startAudit(startInput());

    expect(second.auditId).toBe(first.auditId);
    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(second.providerVersion).toBe("persisted-v1");
    expect(workflowMocks.create).toHaveBeenCalledTimes(1);
    expect(repositoryMocks.acquireDispatchLease).toHaveBeenCalledTimes(1);
  });

  it("reconciles a lost create response against the deterministic Workflow ID", async () => {
    repositoryMocks.findAuditByIdempotencyKey.mockResolvedValue(undefined);
    repositoryMocks.createAudit.mockResolvedValue(true);
    workflowMocks.create.mockRejectedValue(new Error("response lost"));

    const result = await AuditService.startAudit(startInput());

    expect(result.idempotent).toBe(false);
    expect(workflowMocks.get).toHaveBeenCalledWith(result.auditId);
    expect(workflowMocks.status).toHaveBeenCalled();
    expect(repositoryMocks.markWorkflowStarted).toHaveBeenCalledWith(
      result.auditId,
    );
    expect(repositoryMocks.deleteAuditForProject).not.toHaveBeenCalled();
  });

  it("retains an idempotent row only when Workflow creation is genuinely ambiguous", async () => {
    repositoryMocks.findAuditByIdempotencyKey.mockResolvedValue(undefined);
    repositoryMocks.createAudit.mockResolvedValue(true);
    workflowMocks.create.mockRejectedValue(new Error("response lost"));
    workflowMocks.status.mockRejectedValue(new Error("status unavailable"));

    await expect(AuditService.startAudit(startInput())).rejects.toMatchObject({
      name: "AmbiguousWorkflowStartError",
    });
    expect(repositoryMocks.deleteAuditForProject).not.toHaveBeenCalled();
    expect(repositoryMocks.releaseDispatchLease).not.toHaveBeenCalled();
  });

  it("releases a dispatch lease and rolls back non-ambiguous failures", async () => {
    repositoryMocks.findAuditByIdempotencyKey.mockResolvedValue(undefined);
    repositoryMocks.createAudit.mockResolvedValue(true);
    repositoryMocks.acquireDispatchLease.mockRejectedValue(
      new Error("lease database unavailable"),
    );

    await expect(AuditService.startAudit(startInput())).rejects.toThrow(
      "lease database unavailable",
    );
    expect(repositoryMocks.releaseDispatchLease).toHaveBeenCalled();
    expect(repositoryMocks.deleteAuditForProject).toHaveBeenCalled();
  });

  it("rejects reuse of a key with different parameters", async () => {
    repositoryMocks.findAuditByIdempotencyKey.mockResolvedValue({
      id: "existing-audit",
      projectId: "project-1",
      startUrl: "https://example.com/",
      config: JSON.stringify({ maxPages: 50, lighthouseStrategy: "auto" }),
      status: "running",
      workflowStartedAt: "2026-08-02T00:00:00.000Z",
      providerVersion: "persisted-v1",
    });

    await expect(
      AuditService.startAudit(
        startInput({ startUrl: "https://different.example/" }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(workflowMocks.create).not.toHaveBeenCalled();
  });

  it("does not start when the same origin already owns a provider slot", async () => {
    repositoryMocks.findAuditByIdempotencyKey.mockResolvedValue(undefined);
    repositoryMocks.createAudit.mockResolvedValue(true);
    repositoryMocks.acquireDispatchLease.mockResolvedValue({
      acquired: false,
      reason: "origin",
    });

    await expect(AuditService.startAudit(startInput())).rejects.toMatchObject({
      code: "AUDIT_ALREADY_RUNNING",
    });
    expect(workflowMocks.create).not.toHaveBeenCalled();
    expect(repositoryMocks.deleteAuditForProject).toHaveBeenCalled();
    expect(repositoryMocks.releaseDispatchLease).toHaveBeenCalled();
  });

  it("requires an idempotency key for service starts", async () => {
    await expect(
      AuditService.startAudit(startInput({ idempotencyKey: undefined })),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(workflowMocks.create).not.toHaveBeenCalled();
  });
});
