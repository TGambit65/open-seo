import { env } from "cloudflare:workers";
import { getAuthMode, isHostedAuthMode } from "@/lib/auth-mode";
import { AppError } from "@/server/lib/errors";
import { resolveCloudflareAccessContext } from "./cloudflareAccess";
import { resolveLocalNoAuthContext } from "./delegated";
import { resolveHostedContext } from "./hosted";
import type { EnsuredUserContext } from "./types";

// Resolves the authenticated user for a request's headers across every auth
// mode. Shared by ensureUserMiddleware (server functions) and raw API routes,
// which can't use function middleware.
export async function resolveUserContextFromHeaders(
  headers: Headers,
): Promise<EnsuredUserContext> {
  const authMode = getAuthMode(env.AUTH_MODE);
  if (authMode === "local_noauth") {
    // Presence of a configured service identity marks an unattended/public
    // integration deployment. Never silently downgrade such a deployment to
    // the unauthenticated local administrator.
    if (env.ACCESS_SERVICE_TOKEN_COMMON_NAME?.trim()) {
      throw new AppError(
        "AUTH_CONFIG_MISSING",
        "ACCESS_SERVICE_TOKEN_COMMON_NAME requires AUTH_MODE=cloudflare_access.",
      );
    }
    return resolveLocalNoAuthContext();
  }
  if (isHostedAuthMode(authMode)) {
    return resolveHostedContext(headers);
  }
  return resolveCloudflareAccessContext(headers);
}
