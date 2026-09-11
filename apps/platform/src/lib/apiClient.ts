"use client";

import { withTokenizationBasePath } from "@/lib/paths";

export async function postJson<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(withTokenizationBasePath(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}
