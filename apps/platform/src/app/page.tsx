import { listTokens } from "@/lib/db/repo";
import DeployedTokenCatalog from "@/components/DeployedTokenCatalog";
import type { TokenRecord } from "@/types";

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  let tokens: TokenRecord[] = [];
  try {
    tokens = listTokens();
  } catch (err) {
    console.error("[DashboardPage] listTokens error:", err);
    tokens = [];
  }

  return <DeployedTokenCatalog tokens={tokens} />;
}
