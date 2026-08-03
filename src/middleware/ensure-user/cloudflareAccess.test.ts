import { describe, expect, it, vi } from "vitest";
import type { JWTPayload } from "jose";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/middleware/ensure-user/delegated", () => ({
  resolveDelegatedContext: vi.fn(),
  resolveFixedDelegatedContext: vi.fn(),
}));

import {
  classifyAccessPrincipal,
  type AccessServiceIdentityConfig,
} from "./cloudflareAccess";

const configuredService: AccessServiceIdentityConfig = {
  commonName: "brutal-client.access",
  userId: "brutal-service",
  userEmail: "brutal-service@example.invalid",
  organizationId: "brutal-organization",
};

function expectErrorCode(run: () => unknown, code: string) {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code });
}

describe("classifyAccessPrincipal", () => {
  it("maps the allowlisted service token to the fixed internal tenant", () => {
    const payload: JWTPayload = {
      common_name: "brutal-client.access",
      sub: "",
    };

    expect(classifyAccessPrincipal(payload, configuredService)).toEqual({
      kind: "service",
      userId: "brutal-service",
      userEmail: "brutal-service@example.invalid",
      organizationId: "brutal-organization",
    });
  });

  it("retains human administrator identities", () => {
    expect(
      classifyAccessPrincipal(
        { sub: "human-id", email: "admin@example.com" },
        configuredService,
      ),
    ).toEqual({
      kind: "human",
      userId: "human-id",
      userEmail: "admin@example.com",
    });
  });

  it("rejects an unrecognized service common name", () => {
    expectErrorCode(
      () =>
        classifyAccessPrincipal(
          { common_name: "other-client.access", sub: "" },
          configuredService,
        ),
      "UNAUTHENTICATED",
    );
  });

  it("rejects incomplete service mapping configuration", () => {
    expectErrorCode(
      () =>
        classifyAccessPrincipal(
          { common_name: "brutal-client.access", sub: "" },
          { ...configuredService, organizationId: null },
        ),
      "AUTH_CONFIG_MISSING",
    );
  });

  it("rejects hybrid or incomplete identities", () => {
    expectErrorCode(
      () =>
        classifyAccessPrincipal(
          {
            common_name: "brutal-client.access",
            sub: "unexpected-human-subject",
          },
          configuredService,
        ),
      "UNAUTHENTICATED",
    );
    expectErrorCode(
      () =>
        classifyAccessPrincipal(
          { sub: "", email: undefined },
          configuredService,
        ),
      "UNAUTHENTICATED",
    );
  });
});
