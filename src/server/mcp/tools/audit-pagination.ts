import { z } from "zod";
import { AppError } from "@/server/lib/errors";

const cursorSchema = z.object({
  version: z.literal(1),
  offset: z.number().int().nonnegative(),
  scope: z.string(),
});

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function decodeCursor(cursor: string | undefined, scope: string): number {
  if (!cursor) return 0;
  try {
    const decoded = cursorSchema.parse(JSON.parse(fromBase64Url(cursor)));
    if (decoded.scope !== scope) throw new Error("cursor scope mismatch");
    return decoded.offset;
  } catch {
    throw new AppError("VALIDATION_ERROR", "Invalid audit cursor.");
  }
}

function encodeCursor(offset: number, scope: string): string {
  return toBase64Url(JSON.stringify({ version: 1, offset, scope }));
}

export function paginateAuditRows<T>(input: {
  rows: T[];
  limit: number;
  cursor?: string;
  scope: string;
}) {
  const offset = decodeCursor(input.cursor, input.scope);
  if (offset > input.rows.length) {
    throw new AppError("VALIDATION_ERROR", "Invalid audit cursor.");
  }
  const rows = input.rows.slice(offset, offset + input.limit);
  const nextOffset = offset + rows.length;
  const nextCursor =
    nextOffset < input.rows.length
      ? encodeCursor(nextOffset, input.scope)
      : null;
  return {
    rows,
    pageInfo: {
      returned: rows.length,
      total: input.rows.length,
      nextCursor,
      hasMore: nextCursor !== null,
    },
  };
}
