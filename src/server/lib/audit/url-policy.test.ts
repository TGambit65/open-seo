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
  targetFetch?: (url: string) => Response,
) {
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = requestUrl(input);
    if (!url.startsWith("https://cloudflare-dns.com/dns-query")) {
      if (!targetFetch) throw new Error(`Unexpected target fetch: ${url}`);
      return targetFetch(url);
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
