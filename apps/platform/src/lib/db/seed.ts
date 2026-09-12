import type Database from "better-sqlite3";

/**
 * Fail-closed architecture: Never insert fabricated or fixture token deployments,
 * fake transaction IDs, or synthetic event logs into the database.
 * 
 * Tokens and event records exist in the database only when genuinely created
 * on-chain and registered via the platform API routes.
 */
export function seedDatabase(_db: Database.Database): void {
  // Production fail-closed: No fabricated tokens, no fake tx IDs, no fixture records.
}
