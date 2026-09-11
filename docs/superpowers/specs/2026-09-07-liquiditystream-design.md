# LiquidityStream: Technical Design Specification
**Autonomous Real-Estate Yield Streaming Engine with Hedera x402 & Superfluid**

- **Date:** 2026-09-07
- **Target Tracks:** Hedera (x402 Agentic Economy Challenge), Superfluid / EVM (Base Sepolia), Chainlink Functions, World ID
- **Base Architecture:** Prism 8 unified Railway container with Hermes AI Agent + MCP + Next.js Platform

---

## Executive Summary
Real-world physical real estate represents an illiquid, siloed asset class where rental yields are traditionally disbursed on monthly or quarterly cycles, creating significant friction, counterparty delay, and opaque accounting for investors. Furthermore, decentralized autonomous agents lack access to real-time, pay-per-query physical address viability checks without relying on centralized, pre-funded API subscriptions.

**Prism 8** addresses this challenge directly by deploying:
1. **A live x402-gated service on Hedera Testnet**: A property verification & physical address validation oracle settled through the **Blocky402** facilitator.
2. **An autonomous consuming agent (Hermes)**: Hermes detects HTTP 402 challenges, pays machine-to-machine micropayments in HBAR/HTS tokens, verifies physical property validity via USPS, and mints compliant real estate tokens on Hedera Token Service (HTS).
3. **Continuous Real-Time Yield Streaming**: Rental cashflows are streamed per-second to investor wallets via **Superfluid CFA** on Base Sepolia, complemented by native **Hedera Scheduled Transactions** and verifiable payment audit trails on **Hedera Consensus Service (HCS)**.

---

## 2. Bounty Qualification & Extra Points Matrix

| Requirement | Implementation in Prism 8 |
|---|---|
| **Host live x402-gated service on Hedera** | Hosted at `/api/x402/property-oracle`, returns HTTP 402 with Blocky402 facilitator headers. |
| **Agent consumes service end-to-end** | Hermes MCP `usps_chainlink` catches 402, signs/submits payment on Hedera, retries with proof, receives data. |
| **Public GitHub repo & Architecture docs** | Detailed `README.md`, setup instructions, architecture flow diagrams. |
| **Pay-per-call / metered data** | Property verification queries metered per call (0.5 HBAR for standard, 1.0 HBAR for deep DPV check). |
| **Verifiable payment audit trails on HCS** | Every x402 settlement writes an immutable audit record to an HCS Topic (`TopicId: 0.0.xxxxx`). |
| **HTS tokens in settlement path** | Supports settlement in native HBAR and HTS custom tokens (e.g. testnet USDC). |
| **Recurring/streamed payments via Scheduled Transactions** | Automated rent payouts scheduled on Hedera via `ScheduleCreate` transactions. |
| **Agent discovery via UCP / Directory** | Exposed at `/.well-known/agent-services.json` and `/api/x402/directory`. |

---

## 3. High-Level Architecture Diagram

```
                                 [ Public / Web Marketplace ]
                                              │
                      ┌───────────────────────┴───────────────────────┐
                      ▼                                               ▼
           ┌──────────────────────┐                       ┌──────────────────────┐
           │ Next.js Storefront   │                       │ Investor Dashboard   │
           │ - Token Catalog      │                       │ - Live fUSDCx Stream │
           │ - Address Form       │                       │ - Hedera Yield Accrual│
           │ - World ID Auth      │                       │ - Rent Simulator     │
           └──────────┬───────────┘                       └──────────┬───────────┘
                      │                                              │
                      └───────────────────────┬──────────────────────┘
                                              │ REST / Internal Webhooks
                                              ▼
                             ┌──────────────────────────────────┐
                             │    Hermes Autonomous Operator    │
                             │ (apps/agent: Server.py + Gateway)│
                             │ - Compliance policy enforcement  │
                             │ - Flow-rate math calculation     │
                             └────────────────┬─────────────────┘
                                              │ MCP Protocol (JSON-RPC)
                 ┌────────────────────────────┴────────────────────────────┐
                 ▼                                                         ▼
    ┌─────────────────────────┐                               ┌─────────────────────────┐
    │   usps_chainlink_mcp    │                               │     superfluid_mcp      │
    │  - Address validation   │                               │  - Create / update flow │
    │  - x402 client handler  │                               │  - Emergency freeze     │
    │  - Hash store & check   │                               │  - Read stream balance  │
    └────────────┬────────────┘                               └────────────┬────────────┘
                 │                                                         │
                 ├───────────────────────────────┐                         │
                 ▼                               ▼                         ▼
   ┌───────────────────────────┐   ┌───────────────────────────┐   ┌───────────────────────────┐
   │    Hedera Testnet         │   │     HCS Audit Topic       │   │       Base Sepolia        │
   │ - x402 Service Settlement │   │ - Verifiable tx receipts  │   │ - PropertyRegistry.sol    │
   │ - HTS Asset Shares        │   │ - Consensus timestamps    │   │ - YieldVault.sol          │
   │ - Scheduled Transactions  │   │ - Publicly auditable      │   │ - USPSChainlinkConsumer   │
   │ - Blocky402 Facilitator   │   │   on HashScan             │   │ - Superfluid CFAv1        │
   └───────────────────────────┘   └───────────────────────────┘   └───────────────────────────┘
```

---

## 4. Component Details & Specifications

### 4.1. The Hedera x402-Gated Property Oracle Service
- **Endpoint**: `POST /api/x402/property-oracle`
- **Request Body**: `{ "street": "456 Oak Avenue", "city": "Miami", "state": "FL", "zip": "33101" }`
- **Unauthenticated Flow**:
  1. Client sends request without payment header.
  2. Endpoint responds with `HTTP 402 Payment Required`:
     ```json
     {
       "status": 402,
       "error": "Payment Required",
       "x402": {
         "version": "1.0",
         "network": "hedera-testnet",
         "facilitator": "blocky402",
         "payee": "0.0.567890",
         "amount": "50000000",
         "unit": "tinybar",
         "displayAmount": "0.5 HBAR",
         "token": "0.0.0",
         "invoiceId": "inv_9f83a2...",
         "auditTopicId": "0.0.789012"
       }
     }
     ```
- **Authenticated Flow**:
  1. Hermes / Client submits payment transaction on Hedera testnet (transferring 0.5 HBAR to `0.0.567890` with memo matching `invoiceId`).
  2. Client retries with header: `X-Payment-Tx: <hedera_tx_id>`.
  3. Service verifies transaction via Blocky402 / Hedera Mirror Node.
  4. Service logs settlement message to HCS Topic:
     ```json
     {
       "event": "X402_PAYMENT_VERIFIED",
       "invoiceId": "inv_9f83a2...",
       "txId": "<hedera_tx_id>",
       "payer": "0.0.agent",
       "service": "property-oracle",
       "amount": "0.5 HBAR"
     }
     ```
  5. Service executes USPS address verification and returns standardized address + DPV deliverable status + address hash.

### 4.2. Agent Discovery Directory
- **Endpoint**: `GET /.well-known/agent-services.json` and `GET /api/x402/directory`
- Exposes machine-readable schema for agent discovery (Universal Commerce Protocol / ACP friendly):
  ```json
  {
    "name": "Prism 8 Real-Estate Oracle",
    "version": "1.0.0",
    "services": [
      {
        "id": "property-address-validation",
        "endpoint": "/api/x402/property-oracle",
        "method": "POST",
        "pricing": {
          "model": "metered_per_call",
          "cost": "0.5 HBAR",
          "network": "hedera-testnet",
          "acceptedTokens": ["HBAR", "0.0.USDC_HTS"]
        }
      }
    ]
  }
  ```

### 4.3. Smart Contracts on Base Sepolia

#### `PropertyRegistry.sol`
- Maps `propertyId` to:
  - `bytes32 addressHash` (SHA-256 / Keccak-256 of USPS standardized address)
  - `bool uspsVerified`
  - `string hederaTokenId` (e.g. `0.0.123456`)
  - `enum PropertyStatus { PENDING, VERIFIED, ACTIVE, FROZEN, SLASHED }`
  - `bool isSlashable`
  - `uint256 monthlyRentUsd`
  - `address vaultAddress`
- Functions: `registerProperty`, `setVerificationStatus` (restricted to Chainlink Consumer/Oracle), `updatePropertyStatus`, `getProperty`.

#### `YieldVault.sol`
- Connects to Superfluid CFAv1 Forwarder on Base Sepolia (`fUSDCx`).
- Holds rental reserves deposited by the tenant bridge.
- `createInvestorStream(address investor, int96 flowRate)`: Computes and opens per-second continuous flow.
- `emergencyFreezeAll()`: Terminates active flows upon compliance or oracle alert.

#### `USPSChainlinkConsumer.sol`
- Implements Chainlink Functions client.
- Passes USPS verification JavaScript query to the Decentralized Oracle Network.
- Receives fulfillment callback and updates `PropertyRegistry.sol`.

### 4.4. MCP Tools for Hermes

#### MCP 1: `usps_chainlink_mcp` (`apps/agent/mcps/usps_chainlink/server.py`)
- `validate_property_address(street, city, state, zip)`:
  - Discovers endpoint from `/api/x402/directory`.
  - Sends request, handles `402 Payment Required`.
  - Submits HBAR micropayment via Hedera SDK.
  - Submits payment receipt to HCS topic.
  - Returns USPS validation result.
- `get_verification_status(property_id)`: Fetches status from `PropertyRegistry`.
- `store_verified_hash(property_id, address_hash)`: Anchors verified hash on-chain.

#### MCP 2: `superfluid_mcp` (`apps/agent/mcps/superfluid/server.py`)
- `create_yield_stream(receiver, flow_rate, property_id)`: Opens CFA stream on Base Sepolia.
- `update_flow_rate(receiver, flow_rate)`: Adjusts flow rate.
- `delete_stream(receiver)`: Closes stream.
- `get_active_streams(property_id)`: Lists stream status and total active outflows.
- `get_stream_balance(receiver)`: Queries real-time streaming balance.

### 4.5. Hermes Agent Identity & Policy (`AGENTS.md` / `CLAUDE.md`)
- Hermes is configured as an autonomous compliance & asset manager:
  1. **Compliance Rule #1**: Never issue an HTS token or register an EVM property without calling `validate_property_address`.
  2. **x402 Rule #2**: When receiving HTTP 402, autonomously sign and settle the micropayment on Hedera testnet up to a 10 HBAR daily limit.
  3. **Stream Rule #3**: When requested to distribute yield, calculate:
     $$\text{flowRate} = \frac{\text{monthlyRent}}{2,592,000} \times \text{investorFraction}$$
     and call `create_yield_stream`.

### 4.6. Frontend Additions (`apps/platform/src`)
1. **Property Creation Form**: With USPS address inputs and live x402 settlement indicator.
2. **Real-Time Stream Dashboard**: Interactive ticking ticker rendering real-time streaming accumulation (fraction of a cent updating every 100ms).
3. **Simulate Tenant Rent Payment**: Interactive trigger button in the dashboard + API route `/api/rent/simulate`.
4. **HCS Audit Explorer**: Direct link to HashScan for the HCS Topic messages and payment transactions.

---

## 5. Verification & Testing Plan

### Automated Checks
- Python unit tests for `usps_chainlink_mcp` and `superfluid_mcp`.
- Next.js API test for `/api/x402/property-oracle` (asserting 402 response on unpaid request, and 200 on paid request).
- Solidity test / compilation using Hardhat or Foundry.

### Manual Verification Flow (5-Minute Hackathon Demo)
1. **Step 1**: Admin chats with Hermes: *"Tokenize 456 Oak Ave, Miami FL 33101, rent $3,800."*
2. **Step 2**: Observe Hermes executing x402 payment on Hedera Testnet, recording receipt on HCS, and receiving USPS confirmation.
3. **Step 3**: Verify HTS token deployed on Hedera Testnet and registered on `PropertyRegistry`.
4. **Step 4**: Connect investor wallet, complete World ID check, receive tokens.
5. **Step 5**: Click "Simulate Tenant Rent Payment" and watch the investor's balance stream upward live on screen.
