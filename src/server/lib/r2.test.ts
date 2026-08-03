import { beforeEach, describe, expect, it, vi } from "vitest";

const r2Mocks = vi.hoisted(() => ({
  delete: vi.fn<(keys: string[]) => Promise<void>>(),
}));

vi.mock("cloudflare:workers", () => ({
  env: { R2: { delete: r2Mocks.delete } },
}));

import { deleteFromR2 } from "./r2";

describe("deleteFromR2", () => {
  beforeEach(() => vi.clearAllMocks());

  it("chunks bulk deletion at the R2 1,000-key limit", async () => {
    const keys = Array.from({ length: 2_001 }, (_, index) => `key-${index}`);
    await deleteFromR2(keys);

    expect(r2Mocks.delete).toHaveBeenCalledTimes(3);
    expect(r2Mocks.delete.mock.calls.map(([batch]) => batch.length)).toEqual([
      1_000, 1_000, 1,
    ]);
  });
});
