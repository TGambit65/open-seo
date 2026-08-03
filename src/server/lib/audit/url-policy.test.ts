import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppError } from "@/server/lib/errors";
import {
  fetchPublicAuditUrl,
  normalizeAndValidateStartUrl,
  validatePublicAuditUrl,
} from "@/server/lib/audit/url-policy";

type DnsRecords = Record<
  string,
  { A?: string[]; AAAA?: string[]; status?: number }
>;

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.toString() : input.url;
}

function dnsResponse(addresses: string[], type: "A" | "AAAA", status = 0) {
  return new Response(
    JSON.stringify({
      Status: status,
      Answer: addresses.map((data) => ({ type: type === "A" ? 1 : 28, data })),
    }),
    { status: 200, headers: { "content-type": "application/dns-json" } },
  );
}

function installDns(
  records: DnsRecords,
  targetFetch?: (url: string, init?: RequestInit) => Response,
) {
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    if (!url.startsWith("https://cloudflare-dns.com/dns-query")) {
      if (!targetFetch) throw new Error(`Unexpected target fetch: ${url}`);
      return targetFetch(url, init);
    }

    const parsed = new URL(url);
    const name = parsed.searchParams.get("name") ?? "";
    const type = parsed.searchParams.get("type");
    if (type !== "A" && type !== "AAAA") {
      throw new Error(`Unexpected DNS query type: ${type ?? "missing"}`);
    }
    const record = records[name];
    return dnsResponse(record?.[type] ?? [], type, record?.status ?? 0);
  });
}

describe("public audit URL policy", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds https, strips fragments, and accepts only public DNS answers", async () => {
    installDns({
      "example.com": {
        A: ["93.184.216.34"],
        AAAA: ["2606:2800:220:1:248:1893:25c8:1946"],
      },
    });

    await expect(
      normalizeAndValidateStartUrl("example.com/path#section"),
    ).resolves.toBe("https://example.com/path");
  });

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1",
    "http://10.0.0.1",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]",
    "http://[::127.0.0.1]",
    "http://[fe80::1]",
    "http://[fc00::1]",
    "http://192.0.2.1",
  ])(
    "blocks local, private, link-local, and reserved target %s",
    async (url) => {
      await expect(normalizeAndValidateStartUrl(url)).rejects.toMatchObject({
        code: "CRAWL_TARGET_BLOCKED",
      } satisfies Partial<AppError>);
    },
  );

  it("rejects credentials and non-public ports", async () => {
    installDns({ "example.com": { A: ["93.184.216.34"] } });

    await expect(
      normalizeAndValidateStartUrl("https://user:password@example.com/"),
    ).rejects.toMatchObject({ code: "CRAWL_TARGET_BLOCKED" });
    await expect(
      normalizeAndValidateStartUrl("https://example.com:8443/"),
    ).rejects.toMatchObject({ code: "CRAWL_TARGET_BLOCKED" });
  });

  it("rejects non-http schemes and invalid URLs", async () => {
    await expect(
      normalizeAndValidateStartUrl("file:///etc/passwd"),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      normalizeAndValidateStartUrl("not a url"),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("fails closed when DNS has no answers", async () => {
    installDns({ "missing.example": {} });
    await expect(
      normalizeAndValidateStartUrl("https://missing.example"),
    ).rejects.toMatchObject({ code: "CRAWL_TARGET_BLOCKED" });
  });

  it("fails closed on resolver errors", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("resolver unavailable"));
    await expect(
      normalizeAndValidateStartUrl("https://example.com"),
    ).rejects.toMatchObject({ code: "CRAWL_TARGET_BLOCKED" });
  });

  it("rejects a mixed public/private DNS answer", async () => {
    installDns({
      "mixed.example": { A: ["93.184.216.34", "10.0.0.9"] },
    });
    await expect(
      normalizeAndValidateStartUrl("https://mixed.example"),
    ).rejects.toMatchObject({ code: "CRAWL_TARGET_BLOCKED" });
  });

  it("rejects an IPv4-compatible private IPv6 DNS answer", async () => {
    installDns({
      "compatible.example": {
        A: ["93.184.216.34"],
        AAAA: ["::7f00:1"],
      },
    });
    await expect(
      normalizeAndValidateStartUrl("https://compatible.example"),
    ).rejects.toMatchObject({ code: "CRAWL_TARGET_BLOCKED" });
  });

  it("validates every redirect before connecting", async () => {
    const connected: string[] = [];
    installDns(
      {
        "public.example": { A: ["93.184.216.34"] },
        "private.example": { A: ["192.168.1.20"] },
      },
      (url) => {
        connected.push(url);
        return new Response(null, {
          status: 302,
          headers: { location: "https://private.example/admin" },
        });
      },
    );

    await expect(
      fetchPublicAuditUrl("https://public.example/start"),
    ).rejects.toMatchObject({ code: "CRAWL_TARGET_BLOCKED" });
    expect(connected).toEqual(["https://public.example/start"]);
  });

  it("follows a bounded public redirect chain", async () => {
    const connected: string[] = [];
    installDns(
      {
        "one.example": { A: ["93.184.216.34"] },
        "two.example": { A: ["93.184.216.35"] },
      },
      (url) => {
        connected.push(url);
        return url.includes("one.example")
          ? new Response(null, {
              status: 302,
              headers: { location: "https://two.example/final" },
            })
          : new Response("ok", { status: 200 });
      },
    );
    await expect(
      fetchPublicAuditUrl("https://one.example/start"),
    ).resolves.toMatchObject({ status: 200 });
    expect(connected).toEqual([
      "https://one.example/start",
      "https://two.example/final",
    ]);
  });

  it("stops a redirect loop at the configured bound", async () => {
    installDns(
      { "loop.example": { A: ["93.184.216.34"] } },
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "/again" },
        }),
    );
    await expect(
      fetchPublicAuditUrl("https://loop.example/start"),
    ).rejects.toMatchObject({
      code: "CRAWL_TARGET_BLOCKED",
      message: "Too many redirects.",
    });
  });

  it("removes credential headers on a cross-origin redirect", async () => {
    const seen = new Map<string, Headers>();
    installDns(
      {
        "one.example": { A: ["93.184.216.34"] },
        "two.example": { A: ["93.184.216.35"] },
      },
      (url, init) => {
        seen.set(url, new Headers(init?.headers));
        return url.includes("one.example")
          ? new Response(null, {
              status: 302,
              headers: { location: "https://two.example/final" },
            })
          : new Response("ok", { status: 200 });
      },
    );
    await fetchPublicAuditUrl("https://one.example/start", {
      headers: {
        Authorization: "Bearer secret",
        Cookie: "session=secret",
        "X-Audit-Trace": "safe",
      },
    });
    expect(seen.get("https://one.example/start")?.get("authorization")).toBe(
      "Bearer secret",
    );
    expect(seen.get("https://two.example/final")?.get("authorization")).toBe(
      null,
    );
    expect(seen.get("https://two.example/final")?.get("cookie")).toBe(null);
    expect(seen.get("https://two.example/final")?.get("x-audit-trace")).toBe(
      "safe",
    );
  });

  it("re-resolves a hostname before each outbound fetch", async () => {
    installDns(
      { "public.example": { A: ["93.184.216.34"] } },
      () => new Response("ok", { status: 200 }),
    );

    await fetchPublicAuditUrl("https://public.example/");
    await fetchPublicAuditUrl("https://public.example/");

    const dnsCalls = vi
      .mocked(fetch)
      .mock.calls.map(([input]) => requestUrl(input))
      .filter((url) => url.startsWith("https://cloudflare-dns.com/dns-query"));
    expect(dnsCalls).toHaveLength(4);
  });

  it("accepts a public IP literal without consulting DNS", async () => {
    await expect(validatePublicAuditUrl("https://8.8.8.8/")).resolves.toBe(
      "https://8.8.8.8/",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
