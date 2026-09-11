import { ApiError, handleRoute } from "@/lib/api/helpers";

export const dynamic = "force-dynamic";

/** Kept as an explicit tombstone for old clients. A plain HTTP call must never renew liveness;
 * only the trusted World verification completion path can do that. */
export async function POST() {
  return handleRoute(async () => {
    throw new ApiError(
      "Manual liveness check-in is disabled. Complete a new World ID Selfie Check instead.",
      410
    );
  });
}
