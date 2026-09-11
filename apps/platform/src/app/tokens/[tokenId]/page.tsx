import { notFound } from "next/navigation";
import { getToken, listEvents, listHolders, listTokenRequestsForToken } from "@/lib/db/repo";
import TokenWorkspace from "@/components/TokenWorkspace";

export const dynamic = "force-dynamic";

export default async function TokenDetailPage({ params }: { params: Promise<{ tokenId: string }> }) {
  const { tokenId } = await params;
  const token = getToken(tokenId);
  if (!token) notFound();

  const holders = listHolders(tokenId);
  const events = listEvents(tokenId);
  const requests = listTokenRequestsForToken(tokenId);
  // Bracket access keeps this value runtime-configurable in the standalone Railway image;
  // direct NEXT_PUBLIC_* access would be frozen into the client bundle during Docker build.
  const appId = process.env.WORLD_APP_ID ?? process.env["NEXT_PUBLIC_WORLD_APP_ID"] ?? "";
  const worldConfig = {
    appId,
    isConfigured: Boolean(
      appId && process.env.WORLD_RP_ID && process.env.WORLD_RP_SIGNING_KEY
    ),
    selfieEnvironment: "production" as const,
    identityEnvironment: "staging" as const,
  };

  return (
    <TokenWorkspace
      token={token}
      holders={holders}
      events={events}
      requests={requests}
      worldConfig={worldConfig}
    />
  );
}
