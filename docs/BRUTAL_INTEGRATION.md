# Brutal Technical Site Health integration

This fork supplies the private OpenSEO MCP contract used by Brutal's paid
Technical Site Health report. It is deliberately pinned and deployed from a
reviewed revision rather than tracking upstream automatically.

## Source and license

- Upstream repository: `every-app/open-seo`
- Reviewed upstream base: `9d19e439905a9a954ccdefe22d9270d7c389695d`
- Integration fork: `TGambit65/open-seo`
- Integration branch: `feat/brutal-technical-site-health`
- Release tag: `brutal-integration-v0.1.3`
- Reviewed integration code: `5095317dd1d7e558617a9cf02faa445b5a1b29a2`

The upstream `LICENSE` file and copyright notice remain unchanged. OpenSEO is
MIT licensed. A production promotion additionally requires a recorded review
of DataForSEO commercial terms and the applicable data-processing agreement;
those approvals are operational evidence, not source-code assertions.

## Deployment boundary

Use separate Cloudflare stages and resources for staging and production. Each
stage must have its own Worker, D1 or Hyperdrive-backed PostgreSQL database, KV
namespaces, R2 bucket, Workflow, Access application, hostname, and secrets.
Deployments use Alchemy; do not hand-edit resource identifiers into source.

The unattended integration is valid only when all of the following are true:

- `AUTH_MODE=cloudflare_access`.
- `ACCESS_SERVICE_TOKEN_COMMON_NAME` matches the one allowlisted service-token
  identity.
- `ACCESS_SERVICE_USER_ID`, `ACCESS_SERVICE_USER_EMAIL`, and
  `ACCESS_SERVICE_ORGANIZATION_ID` map that identity to one fixed internal
  service user and organization.
- `ACCESS_APPLICATION_HOSTNAME` names the Access-protected custom hostname.
- Direct `workers.dev` and preview URLs are disabled for the integration
  deployment.
- Human administrators are admitted by the separate Access email policy.
- `DATAFORSEO_API_KEY` is stored only in the platform secret store.

An incomplete service identity fails deployment and authentication. Production
must never use `local_noauth`.

## Contract pinned by Brutal

The release exposes versioned, strict MCP results for:

- `run_site_audit`, including an `idempotencyKey` and explicit Lighthouse
  selection;
- `get_audit_status` by exact audit ID;
- `get_audit_pages` and `get_audit_issues` with opaque cursors and completeness
  metadata;
- `get_audit_performance` with mobile and desktop samples, medians, worst
  metrics, failures, provider versions, and actual provider cost; and
- `delete_site_audit` for retention cleanup.

All audit output objects reject unknown fields. The checked-in `tools/list`
fixture also fails on added, removed, or renamed audit tools without depending
on registration order, so a contract change cannot silently bypass review.

Lighthouse defaults off for ordinary callers. The Brutal service identity must
request exactly 50 pages and explicitly enable Lighthouse. Provider controls
limit the run to ten sampled pages on mobile and desktop, two concurrent audits
globally, one audit per origin, a maximum reserved cost of USD 0.25 per audit,
USD 10 per UTC calendar day, USD 100 per calendar month, and seven days of raw-result
retention.

## Network stop-gate

The crawler rejects credentials, non-HTTP(S) URLs, non-public ports, missing DNS
answers, and every private or reserved A and AAAA address. It revalidates all
addresses on every redirect and fetch. DNS lookups are bounded,
IPv4-compatible IPv6 forms are rejected, and cross-origin redirects do not
forward credentials or cookies. `global_fetch_strictly_public` makes same-zone
requests use Cloudflare's public front door; it is not DNS pinning and is not
accepted as standalone rebinding proof.

Audit dispatch distinguishes an ambiguous Workflow response from a confirmed
failure: only an ambiguous idempotent start is retained for reconciliation.
Successful Lighthouse rows are reused across Workflow retries, provider spend is
queried once per phase, and budget exhaustion stops further Lighthouse dispatch.
Scheduled retention and cleanup jobs fail independently, and R2 deletion is
chunked to the platform's 1,000-key limit.

Production promotion remains blocked until live tests prove that direct-origin
bypass, localhost, private ranges, link-local ranges, IPv6-local ranges,
mixed public/private answers, redirects to private targets, DNS errors, and
rebinding cannot connect.

## Release verification

Before moving this tag into staging, record the exact tag SHA and run:

```sh
pnpm install --frozen-lockfile
pnpm types:check
pnpm lint
pnpm test:ci
pnpm format:check
pnpm build
```

Replay every D1 migration into an empty local database and compare the checked-in
`src/server/mcp/fixtures/tools-list.brutal-audit.json` fixture with staging's
`tools/list` response. Redact credentials and URL query parameters from all
evidence.

Do not advance the tag on the basis of local tests alone. Access restart and
rotation, 24-hour unattended operation, staging contract parity, provider cost,
retention, and external SSRF probes are separate release gates.
