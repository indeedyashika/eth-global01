import { ApiError } from "@/lib/api/helpers";
import { getSessionById, type AgentSessionRecord } from "@/lib/hermes/sessionPolicy";

function activeSession(req: Request): AgentSessionRecord {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || req.headers.get("x-prism-session") || "";
  if (!token) throw new ApiError("Authentication required", 401);
  const session = getSessionById(token);
  if (!session || session.status !== "ACTIVE" || session.validAfter > Date.now() || session.validUntil <= Date.now()) {
    throw new ApiError("Authentication required", 401);
  }
  return session;
}

/** Server configuration, not a caller-supplied role, defines privileged users. */
export function requireOperatorSession(req: Request): AgentSessionRecord {
  const session = activeSession(req);
  const allowed = (process.env.PRISM_OPERATOR_ADDRESSES || "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(session.grantor.toLowerCase())) throw new ApiError("Operator authorization required", 403);
  return session;
}

export function requireAuthenticatedSession(req: Request): AgentSessionRecord {
  return activeSession(req);
}
