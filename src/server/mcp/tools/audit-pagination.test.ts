import { describe, expect, it } from "vitest";
import { paginateAuditRows } from "./audit-pagination";

function expectErrorCode(run: () => unknown, code: string) {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code });
}

describe("paginateAuditRows", () => {
  it("returns every row exactly once across opaque cursor pages", () => {
    const input = Array.from({ length: 1_205 }, (_, index) => index);
    const first = paginateAuditRows({
      rows: input,
      limit: 1_000,
      scope: "pages",
    });
    const second = paginateAuditRows({
      rows: input,
      limit: 1_000,
      cursor: first.pageInfo.nextCursor ?? undefined,
      scope: "pages",
    });

    expect(first.rows).toHaveLength(1_000);
    expect(second.rows).toHaveLength(205);
    expect([...first.rows, ...second.rows]).toEqual(input);
    expect(second.pageInfo.nextCursor).toBeNull();
  });

  it("rejects malformed and cross-filter cursors", () => {
    expectErrorCode(
      () =>
        paginateAuditRows({
          rows: [1],
          limit: 1,
          cursor: "garbage",
          scope: "a",
        }),
      "VALIDATION_ERROR",
    );

    const first = paginateAuditRows({ rows: [1, 2], limit: 1, scope: "a" });
    expectErrorCode(
      () =>
        paginateAuditRows({
          rows: [1, 2],
          limit: 1,
          cursor: first.pageInfo.nextCursor ?? undefined,
          scope: "b",
        }),
      "VALIDATION_ERROR",
    );
  });
});
