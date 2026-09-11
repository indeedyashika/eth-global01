import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import { getToken } from "@/lib/db/repo";
import type { TokenRecord } from "@/types";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function requireToken(tokenId: string): TokenRecord {
  const token = getToken(tokenId);
  if (!token) throw new ApiError(`Token ${tokenId} not found`, 404);
  return token;
}

/** Agent-only endpoints are reachable through the public reverse proxy too, so MCP calls carry
 *  a per-container shared secret. This prevents a storefront visitor from invoking treasury
 *  fulfillment directly while keeping the MCP transport on loopback. */
export function requireAgentRequest(req: Request): void {
  const expected = process.env.TOKENIZATION_AGENT_SECRET;
  if (!expected) throw new ApiError("Agent API is not configured", 503);

  const received = req.headers.get("x-tokenization-agent-secret") ?? "";
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  if (
    expectedBuffer.length !== receivedBuffer.length ||
    !timingSafeEqual(expectedBuffer, receivedBuffer)
  ) {
    throw new ApiError("Unauthorized agent request", 401);
  }
}

export function parseRequestId(value: string): number {
  if (!/^\d+$/.test(value)) throw new ApiError("Invalid token request id", 400);
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new ApiError("Invalid token request id", 400);
  return id;
}

export function parseWorldIdVerificationId(value: string): number {
  if (!/^\d+$/.test(value)) throw new ApiError("Invalid World ID verification id", 400);
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new ApiError("Invalid World ID verification id", 400);
  }
  return id;
}

/** Wraps a route handler body so thrown ApiErrors (and Hedera SDK errors) become JSON responses. */
export async function handleRoute(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof ZodError) {
      const message = err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      return NextResponse.json({ error: message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new ApiError("Request body must be valid JSON", 400);
  }
}
