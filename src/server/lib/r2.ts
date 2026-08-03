import { env } from "cloudflare:workers";

export async function getJsonFromR2(key: string): Promise<string> {
  const object = await env.R2.get(key);
  if (!object) {
    throw new Error("Audit payload not found");
  }

  return object.text();
}

export async function putTextToR2(
  key: string,
  body: string,
): Promise<{ key: string; sizeBytes: number }> {
  await env.R2.put(key, body, {
    httpMetadata: {
      contentType: "application/json",
    },
  });

  return {
    key,
    sizeBytes: Buffer.byteLength(body),
  };
}

export async function deleteFromR2(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  for (let index = 0; index < keys.length; index += 1_000) {
    await env.R2.delete(keys.slice(index, index + 1_000));
  }
}
