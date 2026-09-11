# Prism 8 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Prism 8 Real-Estate Yield Streaming Engine, transforming real estate tokenization into an autonomous real-estate yield streaming engine featuring an x402-gated Hedera property oracle (Blocky402), HCS verifiable audit trails, Superfluid CFA per-second yield streaming on Base Sepolia, and compliance-enforcing Hermes MCP tools.
- Preserve the single-container Railway deploy model (`apps/agent/server.py` reverse proxying `apps/platform`). Next.js storefront/API + `apps/agent` Hermes Python operator). The Next.js backend serves the x402-gated USPS property oracle, HCS audit logger, and simulated rent bridge. Base Sepolia hosts `PropertyRegistry.sol` and `YieldVault.sol` (Superfluid CFA). Hermes operates autonomous MCP servers for x402 address verification and Superfluid stream orchestration.

**Tech Stack:** TypeScript, Next.js 15, React 19, `@hiero-ledger/sdk` (Hedera), Python 3.11+, Web3.py, Solidity, Superfluid CFAv1, Chainlink Functions, TailwindCSS.

## Global Constraints
- Target testnets: Hedera Testnet for x402 & HTS tokenization; Base Sepolia for Superfluid CFA and Chainlink Functions.
- Preserve the single-container Railway deploy model (`apps/agent/server.py` reverse proxying `apps/platform`).
- Zero API keys or subscriptions required for agent operations—pure x402 machine-to-machine payment.

---

### Task 1: Hedera x402 Property Oracle Service & HCS Audit Trail Engine

**Files:**
- Create: `apps/platform/src/lib/hedera/hcsAudit.ts`
- Create: `apps/platform/src/lib/hedera/scheduledYield.ts`
- Create: `apps/platform/src/app/api/x402/property-oracle/route.ts`
- Create: `apps/platform/src/app/api/x402/directory/route.ts`
- Create: `apps/platform/public/.well-known/agent-services.json`
- Test: `apps/platform/scripts/test-x402-oracle.mjs`

**Interfaces:**
- Produces:
  - `POST /api/x402/property-oracle`: Returns HTTP 402 when unpaid; returns standardized address, DPV deliverable status, address hash, and HCS audit receipt when payment is verified.
  - `GET /.well-known/agent-services.json`: Machine-readable agent discovery directory.
  - `logHcsAuditEvent(topicId: string, event: HcsEventPayload): Promise<string>`: Submits consensus timestamped receipt to HCS.

- [ ] **Step 1: Write failing test for x402 oracle endpoint**
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement HCS audit logger and x402 property oracle route with Blocky402 / Hedera verification**
- [ ] **Step 4: Implement agent discovery directory endpoints**
- [ ] **Step 5: Run test to verify 402 rejection on unpaid request and 200 acceptance on paid proof**
- [ ] **Step 6: Commit**

---

### Task 2: Base Sepolia Smart Contracts (PropertyRegistry, YieldVault & USPS Chainlink Consumer)

**Files:**
- Create: `apps/platform/contracts/PropertyRegistry.sol`
- Create: `apps/platform/contracts/YieldVault.sol`
- Create: `apps/platform/contracts/USPSChainlinkConsumer.sol`
- Create: `apps/platform/contracts/interfaces/ISuperfluidCFA.sol`
- Create: `apps/platform/scripts/test-contracts.mjs`

**Interfaces:**
- Produces:
  - `PropertyRegistry`: Stores `addressHash`, `uspsVerified`, `hederaTokenId`, status, `isSlashable`, `monthlyRentUsd`.
  - `YieldVault`: Manages `fUSDCx` Super Token reserves, opens/closes Superfluid CFA flows, and provides `depositRent`.
  - `USPSChainlinkConsumer`: Triggers off-chain DON execution and receives callback updating `PropertyRegistry`.

- [ ] **Step 1: Write contract unit tests in `scripts/test-contracts.mjs`**
- [ ] **Step 2: Run test to verify compilation fails before contracts exist**
- [ ] **Step 3: Implement `PropertyRegistry.sol` with lifecycle statuses and slashing controls**
- [ ] **Step 4: Implement `YieldVault.sol` with Superfluid CFAv1 integration**
- [ ] **Step 5: Implement `USPSChainlinkConsumer.sol` and off-chain USPS verification JS source**
- [ ] **Step 6: Run compilation and test script**
- [ ] **Step 7: Commit**

---

### Task 3: USPS Chainlink MCP Server with Autonomous x402 Client

**Files:**
- Create: `apps/agent/mcps/usps_chainlink/server.py`
- Create: `apps/agent/mcps/usps_chainlink/test_server.py`

**Interfaces:**
- Produces MCP tools:
  - `validate_property_address(street, city, state, zip)`
  - `get_verification_status(property_id)`
  - `store_verified_hash(property_id, address_hash)`

- [ ] **Step 1: Write failing Python unit test for `usps_chainlink` MCP tools**
- [ ] **Step 2: Run test to verify failure**
- [ ] **Step 3: Implement `usps_chainlink/server.py` with autonomous x402 payment handling via Hedera SDK**
- [ ] **Step 4: Run test to verify tools execute properly**
- [ ] **Step 5: Commit**

---

### Task 4: Superfluid MCP Server for CFA Stream Management

**Files:**
- Create: `apps/agent/mcps/superfluid/server.py`
- Create: `apps/agent/mcps/superfluid/test_server.py`

**Interfaces:**
- Produces MCP tools:
  - `create_yield_stream(receiver, flow_rate, property_id)`
  - `update_flow_rate(receiver, flow_rate)`
  - `delete_stream(receiver)`
  - `get_active_streams(property_id)`
  - `get_stream_balance(receiver)`

- [ ] **Step 1: Write failing Python unit test for `superfluid` MCP tools**
- [ ] **Step 2: Run test to verify failure**
- [ ] **Step 3: Implement `superfluid/server.py` using Web3.py against Base Sepolia CFA contracts**
- [ ] **Step 4: Run test to verify stream creation, flow calculation, and balance queries**
- [ ] **Step 5: Commit**

---

### Task 5: Hermes Operator Server Integration & Compliance Policy

**Files:**
- Modify: `apps/agent/server.py` (register `usps_chainlink` and `superfluid` in `_ensure_mcp_entry`)
- Modify: `apps/agent/agent-identity/AGENTS.md` (add mandatory USPS check & x402 payment policy)
- Modify: `apps/agent/agent-identity/CLAUDE.md` (add real-estate tokenization instructions)

**Interfaces:**
- Hermes registers and starts both new MCP servers during gateway initialization.
- System prompt instructs Hermes on autonomous x402 payments and compliance rules.

- [ ] **Step 1: Register `usps_chainlink` and `superfluid` MCP servers in `apps/agent/server.py`**
- [ ] **Step 2: Update `AGENTS.md` and `CLAUDE.md` with policy rules**
- [ ] **Step 3: Test MCP configuration generation in `server.py`**
- [ ] **Step 4: Commit**

---

### Task 6: Frontend Additions: Tokenization Form, Live Stream Dashboard & Rent Simulator

**Files:**
- Create: `apps/platform/src/components/PropertyTokenizeModal.tsx`
- Create: `apps/platform/src/components/InvestorStreamDashboard.tsx`
- Create: `apps/platform/src/components/RentSimulatorPanel.tsx`
- Create: `apps/platform/src/components/HcsAuditBadge.tsx`
- Create: `apps/platform/src/app/api/rent/simulate/route.ts`
- Modify: `apps/platform/src/components/RwaMarketplace.tsx`
- Modify: `apps/platform/src/app/page.tsx`

**Interfaces:**
- Produces:
  - Interactive property listing modal with live x402 validation status badge.
  - Real-time continuous ticking stream counter (updating balance every 100ms).
  - "Simulate Tenant Rent Payment" button triggering continuous yield and HCS audit trail.

- [ ] **Step 1: Implement `PropertyTokenizeModal.tsx` with USPS inputs and x402 payment indicator**
- [ ] **Step 2: Implement `InvestorStreamDashboard.tsx` with real-time per-second ticking counter**
- [ ] **Step 3: Implement `RentSimulatorPanel.tsx` and simulated rent API route**
- [ ] **Step 4: Implement `HcsAuditBadge.tsx` linking to HashScan consensus records**
- [ ] **Step 5: Integrate components into `RwaMarketplace.tsx` and `app/page.tsx`**
- [ ] **Step 6: Build and verify Next.js frontend**
- [ ] **Step 7: Commit**

---

### Task 7: End-to-End Verification & 5-Minute Hackathon Demo Script

**Files:**
- Create: `docs/demo-script.md`
- Modify: `README.md`

- [ ] **Step 1: Write `docs/demo-script.md` with step-by-step instructions for judges**
- [ ] **Step 2: Update `README.md` with Prism 8 architecture, x402 setup, and sponsor track alignment**
- [ ] **Step 3: Run comprehensive end-to-end verification script**
- [ ] **Step 4: Commit**
