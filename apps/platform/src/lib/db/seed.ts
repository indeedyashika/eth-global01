import type Database from "better-sqlite3";

export function seedDatabase(db: Database.Database): void {
  // Check if our flagship showcase token already exists
  const countRow = db.prepare("SELECT COUNT(*) as count FROM tokens").get() as { count: number };
  const oakToken = db.prepare("SELECT id FROM tokens WHERE id = '0.0.4491823'").get();

  const insertToken = db.prepare(`
    INSERT OR REPLACE INTO tokens (
      id, blockchain, network, name, symbol, token_type, decimals, initial_supply, supply_type, max_supply,
      treasury_account_id, asset_category, memo,
      kyc_required, freeze_default, wipe_enabled, pause_enabled, world_id_required,
      world_id_selfie_check, world_id_minimum_age, world_id_nationality,
      liveness_enabled, liveness_period_seconds,
      custom_fee_enabled, custom_fee_config,
      has_admin_key, has_kyc_key, has_freeze_key, has_wipe_key, has_pause_key, has_supply_key, has_fee_schedule_key,
      paused, create_tx_id, created_at
    ) VALUES (
      @id, @blockchain, @network, @name, @symbol, @token_type, @decimals, @initial_supply, @supply_type, @max_supply,
      @treasury_account_id, @asset_category, @memo,
      @kyc_required, @freeze_default, @wipe_enabled, @pause_enabled, @world_id_required,
      @world_id_selfie_check, @world_id_minimum_age, @world_id_nationality,
      @liveness_enabled, @liveness_period_seconds,
      @custom_fee_enabled, @custom_fee_config,
      @has_admin_key, @has_kyc_key, @has_freeze_key, @has_wipe_key, @has_pause_key, @has_supply_key, @has_fee_schedule_key,
      @paused, @create_tx_id, @created_at
    )
  `);

  const insertHolder = db.prepare(`
    INSERT OR REPLACE INTO holders (
      token_id, account_id, evm_address,
      associated, kyc_granted, frozen, allowance_granted,
      world_id_verified_at, world_id_selfie_verified_at, world_id_identity_verified_at,
      last_checkin_at, active_schedule_id, active_schedule_expires_at,
      liveness_reclaim_status, liveness_reclaim_error, liveness_reclaim_attempted_at,
      status, created_at, updated_at
    ) VALUES (
      @token_id, @account_id, @evm_address,
      @associated, @kyc_granted, @frozen, @allowance_granted,
      @world_id_verified_at, @world_id_selfie_verified_at, @world_id_identity_verified_at,
      @last_checkin_at, @active_schedule_id, @active_schedule_expires_at,
      @liveness_reclaim_status, @liveness_reclaim_error, @liveness_reclaim_attempted_at,
      @status, @created_at, @updated_at
    )
  `);

  const insertEvent = db.prepare(`
    INSERT INTO events (token_id, account_id, type, detail, tx_id, hashscan_url, created_at)
    VALUES (@token_id, @account_id, @type, @detail, @tx_id, @hashscan_url, @created_at)
  `);

  // Seed Property 1: 456 Oak Avenue Luxury Residences (Hedera HTS + Base Sepolia CFA Stream)
  if (!oakToken) {
    insertToken.run({
      id: "0.0.4491823",
      blockchain: "HEDERA",
      network: "testnet",
      name: "456 Oak Avenue Luxury Residences",
      symbol: "OAK456",
      token_type: "FUNGIBLE",
      decimals: 0,
      initial_supply: "1000",
      supply_type: "FINITE",
      max_supply: "1000",
      treasury_account_id: "0.0.4491823",
      asset_category: "real-estate",
      memo: "Miami FL 33101 · USPS DPV Validated · $3,800/mo Superfluid CFA Yield · Base Sepolia Stream: 0xcfA132E353cB4E398080B9700609bb008eceB125",
      kyc_required: 1,
      freeze_default: 0,
      wipe_enabled: 1,
      pause_enabled: 1,
      world_id_required: 1,
      world_id_selfie_check: 1,
      world_id_minimum_age: 18,
      world_id_nationality: null,
      liveness_enabled: 1,
      liveness_period_seconds: 604800,
      custom_fee_enabled: 0,
      custom_fee_config: null,
      has_admin_key: 1,
      has_kyc_key: 1,
      has_freeze_key: 1,
      has_wipe_key: 1,
      has_pause_key: 1,
      has_supply_key: 1,
      has_fee_schedule_key: 0,
      paused: 0,
      create_tx_id: "0.0.4491823@1789066000.000000000",
      created_at: new Date(Date.now() - 3600000 * 24).toISOString(),
    });

    // Seed Holders for Oak Avenue
    const now = new Date().toISOString();
    insertHolder.run({
      token_id: "0.0.4491823",
      account_id: "0.0.4491823",
      evm_address: "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7",
      associated: 1,
      kyc_granted: 1,
      frozen: 0,
      allowance_granted: 1,
      world_id_verified_at: now,
      world_id_selfie_verified_at: now,
      world_id_identity_verified_at: now,
      last_checkin_at: now,
      active_schedule_id: null,
      active_schedule_expires_at: null,
      liveness_reclaim_status: "IDLE",
      liveness_reclaim_error: null,
      liveness_reclaim_attempted_at: null,
      status: "WHITELISTED",
      created_at: now,
      updated_at: now,
    });

    insertHolder.run({
      token_id: "0.0.4491823",
      account_id: "0x742d35cc6634c0532925a3b844bc454e4438f44e",
      evm_address: "0x742d35cc6634c0532925a3b844bc454e4438f44e",
      associated: 1,
      kyc_granted: 1,
      frozen: 0,
      allowance_granted: 1,
      world_id_verified_at: now,
      world_id_selfie_verified_at: now,
      world_id_identity_verified_at: null,
      last_checkin_at: now,
      active_schedule_id: null,
      active_schedule_expires_at: null,
      liveness_reclaim_status: "IDLE",
      liveness_reclaim_error: null,
      liveness_reclaim_attempted_at: null,
      status: "WHITELISTED",
      created_at: now,
      updated_at: now,
    });

    insertHolder.run({
      token_id: "0.0.4491823",
      account_id: "0x28a8746e75304c0780e011bed21c72cd78cd535e",
      evm_address: "0x28a8746e75304c0780e011bed21c72cd78cd535e",
      associated: 1,
      kyc_granted: 1,
      frozen: 0,
      allowance_granted: 1,
      world_id_verified_at: now,
      world_id_selfie_verified_at: now,
      world_id_identity_verified_at: now,
      last_checkin_at: now,
      active_schedule_id: null,
      active_schedule_expires_at: null,
      liveness_reclaim_status: "IDLE",
      liveness_reclaim_error: null,
      liveness_reclaim_attempted_at: null,
      status: "WHITELISTED",
      created_at: now,
      updated_at: now,
    });

    insertHolder.run({
      token_id: "0.0.4491823",
      account_id: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
      evm_address: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
      associated: 1,
      kyc_granted: 1,
      frozen: 0,
      allowance_granted: 0,
      world_id_verified_at: now,
      world_id_selfie_verified_at: now,
      world_id_identity_verified_at: null,
      last_checkin_at: now,
      active_schedule_id: null,
      active_schedule_expires_at: null,
      liveness_reclaim_status: "IDLE",
      liveness_reclaim_error: null,
      liveness_reclaim_attempted_at: null,
      status: "WHITELISTED",
      created_at: now,
      updated_at: now,
    });

    // Seed Events for Oak Avenue
    insertEvent.run({
      token_id: "0.0.4491823",
      account_id: "0.0.4491823",
      type: "CREATE_TOKEN",
      detail: JSON.stringify({
        name: "456 Oak Avenue Luxury Residences",
        symbol: "OAK456",
        initialSupply: 1000,
        blockchain: "HEDERA",
        network: "testnet",
      }),
      tx_id: "0.0.4491823@1789066000.000000000",
      hashscan_url: "https://hashscan.io/testnet/transaction/0.0.4491823@1789066000.000000000",
      created_at: new Date(Date.now() - 3600000 * 20).toISOString(),
    });

    insertEvent.run({
      token_id: "0.0.4491823",
      account_id: "0x742d35cc6634c0532925a3b844bc454e4438f44e",
      type: "WORLDID_VERIFY",
      detail: JSON.stringify({
        check: "selfie",
        credential: "orb",
        action: "rwa-investor-whitelist",
      }),
      tx_id: "0.0.5180265-1789066233-697953817",
      hashscan_url: "https://hashscan.io/testnet/transaction/0.0.5180265-1789066233-697953817",
      created_at: new Date(Date.now() - 3600000 * 12).toISOString(),
    });

    insertEvent.run({
      token_id: "0.0.4491823",
      account_id: "0x28a8746e75304c0780e011bed21c72cd78cd535e",
      type: "TOKEN_MINTED",
      detail: JSON.stringify({
        recipient: "0x28a8746e75304c0780e011bed21c72cd78cd535e",
        shares: 100,
        sharePercentage: "10%",
      }),
      tx_id: "0.0.7095826-1789066232-061237484",
      hashscan_url: "https://hashscan.io/testnet/transaction/0.0.7095826-1789066232-061237484",
      created_at: new Date(Date.now() - 3600000 * 6).toISOString(),
    });

    insertEvent.run({
      token_id: "0.0.4491823",
      account_id: "0.0.4491823",
      type: "TRANSFER",
      detail: JSON.stringify({
        action: "TENANT_RENT_DEPOSITED",
        amount: "$3,800.00 USD",
        tenant: "Acme Residential Tenant Corp",
        flowRatePerSec: 0.0001466049,
        hcsSequenceNumber: 65922,
      }),
      tx_id: "0.0.4491823@1789066100.000000000",
      hashscan_url: "https://hashscan.io/testnet/topic/0.0.4491823",
      created_at: new Date(Date.now() - 3600000 * 2).toISOString(),
    });
  }

  // Seed Property 2: 789 Brickell Bay Penthouse (EVM Sepolia Compliant RWA)
  const brickellToken = db.prepare("SELECT id FROM tokens WHERE id = '0x71C8401E25687352f20D235F8d7fD1A392cf99a8'").get();
  if (!brickellToken) {
    insertToken.run({
      id: "0x71C8401E25687352f20D235F8d7fD1A392cf99a8",
      blockchain: "EVM",
      network: "sepolia",
      name: "789 Brickell Bay Penthouse",
      symbol: "BRK789",
      token_type: "FUNGIBLE",
      decimals: 18,
      initial_supply: "10000",
      supply_type: "FINITE",
      max_supply: "10000",
      treasury_account_id: "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7",
      asset_category: "real-estate",
      memo: "Miami FL 33131 · USPS DPV Validated · $12,500/mo Rent · The Graph Studio Indexed",
      kyc_required: 1,
      freeze_default: 0,
      wipe_enabled: 1,
      pause_enabled: 1,
      world_id_required: 1,
      world_id_selfie_check: 1,
      world_id_minimum_age: 18,
      world_id_nationality: null,
      liveness_enabled: 0,
      liveness_period_seconds: null,
      custom_fee_enabled: 0,
      custom_fee_config: null,
      has_admin_key: 1,
      has_kyc_key: 1,
      has_freeze_key: 1,
      has_wipe_key: 1,
      has_pause_key: 1,
      has_supply_key: 1,
      has_fee_schedule_key: 0,
      paused: 0,
      create_tx_id: "0x1e0d77de7d53b824bd0d925cc768efc21bff74cfc51f8ced8f45298fc337f4f2",
      created_at: new Date(Date.now() - 3600000 * 48).toISOString(),
    });

    const now = new Date().toISOString();
    insertHolder.run({
      token_id: "0x71C8401E25687352f20D235F8d7fD1A392cf99a8",
      account_id: "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7",
      evm_address: "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7",
      associated: 1,
      kyc_granted: 1,
      frozen: 0,
      allowance_granted: 1,
      world_id_verified_at: now,
      world_id_selfie_verified_at: now,
      world_id_identity_verified_at: now,
      last_checkin_at: now,
      active_schedule_id: null,
      active_schedule_expires_at: null,
      liveness_reclaim_status: "IDLE",
      liveness_reclaim_error: null,
      liveness_reclaim_attempted_at: null,
      status: "WHITELISTED",
      created_at: now,
      updated_at: now,
    });

    insertHolder.run({
      token_id: "0x71C8401E25687352f20D235F8d7fD1A392cf99a8",
      account_id: "0x742d35cc6634c0532925a3b844bc454e4438f44e",
      evm_address: "0x742d35cc6634c0532925a3b844bc454e4438f44e",
      associated: 1,
      kyc_granted: 1,
      frozen: 0,
      allowance_granted: 1,
      world_id_verified_at: now,
      world_id_selfie_verified_at: now,
      world_id_identity_verified_at: null,
      last_checkin_at: now,
      active_schedule_id: null,
      active_schedule_expires_at: null,
      liveness_reclaim_status: "IDLE",
      liveness_reclaim_error: null,
      liveness_reclaim_attempted_at: null,
      status: "WHITELISTED",
      created_at: now,
      updated_at: now,
    });

    insertEvent.run({
      token_id: "0x71C8401E25687352f20D235F8d7fD1A392cf99a8",
      account_id: "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7",
      type: "CREATE_TOKEN",
      detail: JSON.stringify({
        name: "789 Brickell Bay Penthouse",
        symbol: "BRK789",
        standard: "CompliantRwaToken (ERC-20 + ERC-7579)",
        network: "sepolia",
      }),
      tx_id: "0x1e0d77de7d53b824bd0d925cc768efc21bff74cfc51f8ced8f45298fc337f4f2",
      hashscan_url: "https://sepolia.etherscan.io/tx/0x1e0d77de7d53b824bd0d925cc768efc21bff74cfc51f8ced8f45298fc337f4f2",
      created_at: new Date(Date.now() - 3600000 * 40).toISOString(),
    });
  }

  // Seed Property 3: 101 Ocean Drive Beachfront Villa
  const oceanToken = db.prepare("SELECT id FROM tokens WHERE id = '0.0.5258180'").get();
  if (!oceanToken) {
    insertToken.run({
      id: "0.0.5258180",
      blockchain: "HEDERA",
      network: "testnet",
      name: "101 Ocean Drive Beachfront Villa",
      symbol: "OCN101",
      token_type: "FUNGIBLE",
      decimals: 0,
      initial_supply: "5000",
      supply_type: "FINITE",
      max_supply: "5000",
      treasury_account_id: "0.0.5258180",
      asset_category: "real-estate",
      memo: "Miami Beach FL 33139 · USPS DPV Validated · $8,200/mo Rental Pool · HCS Topic 0.0.4491823",
      kyc_required: 1,
      freeze_default: 0,
      wipe_enabled: 1,
      pause_enabled: 1,
      world_id_required: 1,
      world_id_selfie_check: 1,
      world_id_minimum_age: null,
      world_id_nationality: null,
      liveness_enabled: 0,
      liveness_period_seconds: null,
      custom_fee_enabled: 0,
      custom_fee_config: null,
      has_admin_key: 1,
      has_kyc_key: 1,
      has_freeze_key: 1,
      has_wipe_key: 1,
      has_pause_key: 1,
      has_supply_key: 1,
      has_fee_schedule_key: 0,
      paused: 0,
      create_tx_id: "0.0.5258180@1789065900.000000000",
      created_at: new Date(Date.now() - 3600000 * 72).toISOString(),
    });

    const now = new Date().toISOString();
    insertHolder.run({
      token_id: "0.0.5258180",
      account_id: "0.0.5258180",
      evm_address: "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7",
      associated: 1,
      kyc_granted: 1,
      frozen: 0,
      allowance_granted: 1,
      world_id_verified_at: now,
      world_id_selfie_verified_at: now,
      world_id_identity_verified_at: null,
      last_checkin_at: now,
      active_schedule_id: null,
      active_schedule_expires_at: null,
      liveness_reclaim_status: "IDLE",
      liveness_reclaim_error: null,
      liveness_reclaim_attempted_at: null,
      status: "WHITELISTED",
      created_at: now,
      updated_at: now,
    });

    insertEvent.run({
      token_id: "0.0.5258180",
      account_id: "0.0.5258180",
      type: "CREATE_TOKEN",
      detail: JSON.stringify({
        name: "101 Ocean Drive Beachfront Villa",
        symbol: "OCN101",
        initialSupply: 5000,
        blockchain: "HEDERA",
        network: "testnet",
      }),
      tx_id: "0.0.5258180@1789065900.000000000",
      hashscan_url: "https://hashscan.io/testnet/token/0.0.5258180",
      created_at: new Date(Date.now() - 3600000 * 60).toISOString(),
    });
  }
}
