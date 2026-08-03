import { AppError } from "@/server/lib/errors";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "169.254.169.254",
  "100.100.100.200",
]);

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".home.arpa",
];

const PUBLIC_WEB_PORTS = new Set(["", "80", "443"]);
const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const MAX_PUBLIC_REDIRECTS = 5;

function normalizeHost(hostname: string): string {
  let host = hostname.toLowerCase().trim();
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  const zoneSeparator = host.indexOf("%");
  if (zoneSeparator !== -1) {
    host = host.slice(0, zoneSeparator);
  }
  if (host.endsWith(".")) {
    host = host.slice(0, -1);
  }
  return host;
}

function parseIpv4(host: string): number[] | null {
  const rawParts = normalizeHost(host).split(".");
  if (rawParts.length !== 4) return null;
  if (rawParts.some((part) => !/^\d{1,3}$/.test(part))) return null;

  const parts = rawParts.map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return null;
  return parts;
}

function ipv4Number(parts: number[]): number {
  return (
    ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
  );
}

function ipv4InCidr(parts: number[], base: string, prefix: number): boolean {
  const baseParts = parseIpv4(base);
  if (!baseParts) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(parts) & mask) === (ipv4Number(baseParts) & mask);
}

// Block every non-globally-routable IPv4 range, including documentation and
// benchmarking ranges. An audit target must be a public web origin, not merely
// "not RFC1918".
const BLOCKED_IPV4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function isBlockedIpv4(host: string): boolean {
  const parts = parseIpv4(host);
  if (!parts) return false;
  return BLOCKED_IPV4_RANGES.some(([base, prefix]) =>
    ipv4InCidr(parts, base, prefix),
  );
}

function parseIpv6(host: string): number[] | null {
  let value = normalizeHost(host);
  if (!value.includes(":")) return null;

  const mappedIpv4 = value.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIpv4) {
    const parts = parseIpv4(mappedIpv4[2]);
    if (!parts) return null;
    value = `${mappedIpv4[1]}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }

  const doubleColonParts = value.split("::");
  if (doubleColonParts.length > 2) return null;
  const left = doubleColonParts[0]
    ? doubleColonParts[0].split(":").filter(Boolean)
    : [];
  const right =
    doubleColonParts.length === 2 && doubleColonParts[1]
      ? doubleColonParts[1].split(":").filter(Boolean)
      : [];
  if (doubleColonParts.length === 1 && left.length !== 8) return null;
  if (doubleColonParts.length === 2 && left.length + right.length >= 8) {
    return null;
  }

  const missing =
    doubleColonParts.length === 2 ? 8 - left.length - right.length : 0;
  const segments = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (
    segments.length !== 8 ||
    segments.some((segment) => !/^[0-9a-f]{1,4}$/i.test(segment))
  ) {
    return null;
  }
  return segments.map((segment) => Number.parseInt(segment, 16));
}

function ipv6InCidr(
  segments: number[],
  base: readonly number[],
  prefix: number,
): boolean {
  let remaining = prefix;
  for (let index = 0; index < 8; index += 1) {
    if (remaining <= 0) return true;
    const bits = Math.min(remaining, 16);
    const mask = bits === 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff;
    if ((segments[index] & mask) !== (base[index] & mask)) return false;
    remaining -= bits;
  }
  return true;
}

const BLOCKED_IPV6_RANGES: ReadonlyArray<readonly [readonly number[], number]> =
  [
    [[0, 0, 0, 0, 0, 0, 0, 0], 128], // unspecified
    [[0, 0, 0, 0, 0, 0, 0, 1], 128], // loopback
    [[0, 0, 0, 0, 0, 0xffff, 0, 0], 96], // IPv4 mapped (checked below)
    [[0x64, 0xff9b, 0, 0, 0, 0, 0, 0], 96], // NAT64 well-known prefix
    [[0x100, 0, 0, 0, 0, 0, 0, 0], 64], // discard-only
    [[0x2001, 0, 0, 0, 0, 0, 0, 0], 23], // IETF protocol assignments
    [[0x2001, 0xdb8, 0, 0, 0, 0, 0, 0], 32], // documentation
    [[0x2002, 0, 0, 0, 0, 0, 0, 0], 16], // 6to4
    [[0xfc00, 0, 0, 0, 0, 0, 0, 0], 7], // unique local
    [[0xfe80, 0, 0, 0, 0, 0, 0, 0], 10], // link local
    [[0xff00, 0, 0, 0, 0, 0, 0, 0], 8], // multicast
  ];

function isBlockedIpv6(host: string): boolean {
  const segments = parseIpv6(host);
  if (!segments) return false;

  const embedsIpv4 =
    segments.slice(0, 5).every((segment) => segment === 0) &&
    (segments[5] === 0 || segments[5] === 0xffff);
  if (embedsIpv4) {
    const mapped = [
      segments[6] >> 8,
      segments[6] & 0xff,
      segments[7] >> 8,
      segments[7] & 0xff,
    ];
    // The deprecated IPv4-compatible ::/96 range is not globally routable,
    // regardless of whether its embedded IPv4 value would otherwise be public.
    if (segments[5] === 0) return true;
    return isBlockedIpv4(mapped.join("."));
  }

  return BLOCKED_IPV6_RANGES.some(([base, prefix]) =>
    ipv6InCidr(segments, base, prefix),
  );
}

function isIpLiteral(host: string): boolean {
  return parseIpv4(host) !== null || parseIpv6(host) !== null;
}

function isBlockedHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (!host) return true;
  if (BLOCKED_HOSTS.has(host)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return true;
  }
  if (parseIpv4(host)) return isBlockedIpv4(host);
  if (parseIpv6(host)) return isBlockedIpv6(host);
  // A hostname containing a colon or an all-numeric dotted value that did not
  // parse cleanly is not a valid public DNS name.
  return host.includes(":") || /^\d+(?:\.\d+){1,}$/.test(host);
}

type DnsJsonAnswer = {
  type?: number;
  data?: string;
};

type DnsJsonResponse = {
  Status?: number;
  Answer?: DnsJsonAnswer[];
};

async function resolveAddressRecords(
  hostname: string,
  type: "A" | "AAAA",
  signal?: AbortSignal | null,
): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch(
      `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`,
      {
        headers: { Accept: "application/dns-json" },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(2_500)])
          : AbortSignal.timeout(2_500),
      },
    );
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw new AppError("CRAWL_TARGET_BLOCKED", "Target DNS lookup failed.");
  }

  if (!response.ok) {
    throw new AppError("CRAWL_TARGET_BLOCKED", "Target DNS lookup failed.");
  }

  let body: DnsJsonResponse;
  try {
    body = await response.json();
  } catch {
    throw new AppError("CRAWL_TARGET_BLOCKED", "Target DNS lookup failed.");
  }
  if (body.Status !== 0) {
    throw new AppError("CRAWL_TARGET_BLOCKED", "Target DNS lookup failed.");
  }

  const expectedType = type === "A" ? 1 : 28;
  return (Array.isArray(body.Answer) ? body.Answer : [])
    .filter(
      (answer): answer is Required<Pick<DnsJsonAnswer, "data" | "type">> =>
        answer.type === expectedType && typeof answer.data === "string",
    )
    .map((answer) => normalizeHost(answer.data));
}

async function assertPublicHostname(
  hostname: string,
  signal?: AbortSignal | null,
): Promise<void> {
  const host = normalizeHost(hostname);
  if (isBlockedHost(host)) {
    throw new AppError("CRAWL_TARGET_BLOCKED");
  }
  if (isIpLiteral(host)) return;

  const [v4, v6] = await Promise.all([
    resolveAddressRecords(host, "A", signal),
    resolveAddressRecords(host, "AAAA", signal),
  ]);
  const addresses = [...v4, ...v6];
  if (addresses.length === 0) {
    throw new AppError(
      "CRAWL_TARGET_BLOCKED",
      "Target hostname has no public A or AAAA records.",
    );
  }
  if (
    addresses.some(
      (address) =>
        !isIpLiteral(address) ||
        isBlockedIpv4(address) ||
        isBlockedIpv6(address),
    )
  ) {
    throw new AppError("CRAWL_TARGET_BLOCKED");
  }
}

function parseAuditUrl(input: string, addDefaultProtocol: boolean): URL {
  let raw = input.trim();
  if (!raw) throw new AppError("VALIDATION_ERROR");
  if (
    addDefaultProtocol &&
    !/^[a-z][a-z0-9+.-]*:/i.test(raw) &&
    !raw.startsWith("http://") &&
    !raw.startsWith("https://")
  ) {
    raw = `https://${raw}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppError("VALIDATION_ERROR");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AppError("VALIDATION_ERROR");
  }
  if (parsed.username || parsed.password) {
    throw new AppError("CRAWL_TARGET_BLOCKED");
  }
  if (!PUBLIC_WEB_PORTS.has(parsed.port)) {
    throw new AppError("CRAWL_TARGET_BLOCKED");
  }
  parsed.hash = "";
  return parsed;
}

/**
 * Validate an arbitrary audit URL immediately before an outbound request.
 * Every DNS answer must be public; lookup errors and empty answers fail closed.
 * `global_fetch_strictly_public` makes same-zone requests traverse Cloudflare's
 * public front door; it does not pin DNS. Production therefore retains an
 * external rebinding stop-gate in addition to this per-hop validation.
 */
export async function validatePublicAuditUrl(
  input: string,
  signal?: AbortSignal | null,
): Promise<string> {
  const parsed = parseAuditUrl(input, false);
  await assertPublicHostname(parsed.hostname, signal);
  return parsed.toString();
}

function withoutCredentialHeaders(init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  for (const name of [
    "authorization",
    "proxy-authorization",
    "cookie",
    "cookie2",
  ]) {
    headers.delete(name);
  }
  return { ...init, headers };
}

/**
 * Fetch a public audit target with explicit redirect handling. Each redirect
 * hop is resolved and validated before the connection is made.
 */
export async function fetchPublicAuditUrl(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  let current = input;
  let previousOrigin: string | null = null;
  for (let redirects = 0; redirects <= MAX_PUBLIC_REDIRECTS; redirects += 1) {
    const validated = await validatePublicAuditUrl(current, init.signal);
    const currentOrigin = new URL(validated).origin;
    const requestInit =
      previousOrigin && previousOrigin !== currentOrigin
        ? withoutCredentialHeaders(init)
        : init;
    const response = await fetch(validated, {
      ...requestInit,
      redirect: "manual",
    });
    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects === MAX_PUBLIC_REDIRECTS) {
      throw new AppError("CRAWL_TARGET_BLOCKED", "Too many redirects.");
    }
    previousOrigin = currentOrigin;
    current = new URL(location, validated).toString();
  }
  throw new AppError("CRAWL_TARGET_BLOCKED");
}

/**
 * Cheap syntax/host screening for discovered links. The asynchronous DNS gate
 * still runs in `crawlPage` immediately before a connection is made.
 */
export function isCrawlableUrl(url: string): boolean {
  try {
    const parsed = parseAuditUrl(url, false);
    return !isBlockedHost(parsed.hostname);
  } catch {
    return false;
  }
}

export async function normalizeAndValidateStartUrl(
  input: string,
): Promise<string> {
  const parsed = parseAuditUrl(input, true);
  await assertPublicHostname(parsed.hostname);
  return parsed.toString();
}
