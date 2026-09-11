# Prism 8: 5-Minute Hackathon Demo Script
**Autonomous Real-Estate Yield Streaming Engine with ERC-7579 Session Keys, Hedera x402, Superfluid, & The Graph**

- **Target Audience:** ETHGlobal Judges (Account Abstraction, Hedera, The Graph, Superfluid tracks)
- **Presenter Role:** Platform Operator / Admin pair programming with Hermes Agent
- **Key Takeaway:** Real-world physical real estate verified via x402 oracle on Hedera, indexed autonomously by The Graph, with scoped AI agent autonomy via ERC-7579 session keys and per-second continuous rental yield streaming via Superfluid CFA on Base Sepolia.

---

## ⏱️ Video & Live Demo Breakdown (Total Time: 4:30)

### [0:00 - 0:45] 1. The Hook: AI Agents with Cryptographic Safety (ERC-7579)
* **Screen:** Storefront homepage (`http://localhost:3000/`) showing the **Prism 8** dashboard and **Hermes Autonomous Mission Cockpit**.
* **Talking Points:**
  > "The biggest dilemma in Web3 AI today is custody: how do we let autonomous AI agents execute economic workflows without giving them full wallet custody or forcing users to sign 50 confirmations?
  >
  > Today, we introduce **Prism 8**: an autonomous real-estate yield streaming protocol powered by **ERC-7579 Modular Account Abstraction**, **Hedera x402**, **The Graph**, and **Superfluid CFA**."
* **Action:**
  1. Scroll to the **Hermes Autonomous Mission Cockpit**.
  2. Click **"✍️ Grant Session Key (EIP-712)"**.
  3. Show the MetaMask popup with structured EIP-712 typed data (Grantee: Hermes, Spend cap: 5 HBAR, Ceiling: $5,000/mo, 24h validity).
  4. Sign to register the on-chain session delegation verified by `SessionKeyValidator.sol`.

---

### [0:45 - 1:45] 2. Autonomous Mission Execution: Cross-Chain x402 & HCS Audit
* **Action:** Click **"⚡ Run Autonomous Mission"** in the Cockpit.
* **Visual Flow:**
  1. **Step 1:** Hermes calls `/api/x402/property-oracle`.
  2. **Step 2:** Server returns `HTTP 402 Payment Required` with the **Blocky402** challenge requesting 0.5 HBAR.
  3. **Step 3:** Hermes autonomously settles the 0.5 HBAR micropayment on Hedera Testnet under its delegated session key allowance.
  4. **Step 4:** The payment receipt is verified and immediately submitted to an **HCS (Hedera Consensus Service) Topic (0.0.4491823)**.
  5. **Step 5:** The oracle validates the USPS address (Code Y Deliverable) and anchors the property hash in `PropertyRegistry.sol`.
* **Talking Points:**
  > "Hermes executed this entire workflow autonomously under its delegated session key. It paid the 0.5 HBAR oracle fee on Hedera Testnet without human approval, and the consensus receipt is permanently verifiable on HashScan."

---

### [1:45 - 2:30] 3. The Graph AI Inspector & Autonomous Indexing
* **Screen:** Click **"Inspect The Graph Subgraph"** button on the storefront homepage.
* **Visual Flow:**
  1. **Live GraphQL Query Runner:** Click **"Top Token Holders (Yield Allocation)"** to see live indexed shareholder balances and derived flow rates.
  2. **MCP Tooling Tab:** Highlight `subgraph_read` (8 query tools) and `subgraph_write` (`add_token_source`).
  3. **Autonomous Pipeline:** Explain that when new properties are tokenized, Hermes uses `subgraph_write.add_token_source` to dynamically edit `subgraph.yaml` and redeploy to Graph Studio without developer intervention.
* **Talking Points:**
  > "For The Graph AI Track, we built dual Model Context Protocol servers. Hermes doesn't just read indexed data—it autonomously mutates the Subgraph manifest and redeploys it to Graph Studio as new assets are created. The Graph provides the live financial source of truth that drives our per-second rental yield distribution."

---

### [2:30 - 3:45] 4. Per-Second Rental Yield Streaming (Superfluid CFA)
* **Screen:** The **Investor Stream Dashboard**.
* **Visual Flow:**
  1. Point to the live ticking yield counter: **`+$0.00014660 / sec`** (Base Sepolia).
  2. Watch the investor balance ticking continuously upward every 80ms.
  3. Click **"Trigger Tenant Rent Deposit"** in the **Rent Simulator Panel** ($3,800 inflow).
  4. Observe the stream update in real-time, with simulated rent converting to `fUSDCx` Super Tokens in `YieldVault.sol`.
* **Talking Points:**
  > "Rent is traditionally paid once a month. With Prism 8, rental yield is unlocked continuously. Every single second, the investor's balance streams in real-time via Superfluid Constant Flow Agreements on Base Sepolia, backed by automated batch settlement via Hedera Scheduled Transactions."

---

### [3:45 - 4:30] 5. Cryptographic Guardrail Benchmark (Intercepting Rogue AI Action)
* **Action:** Click **"🛡️ Test Guardrail (Simulate Rogue Action)"** in the Cockpit.
* **Visual Flow:**
  1. The agent attempts an unauthorized treasury drain of 100 HBAR.
  2. The backend `SessionPolicy` guardrail and `SessionKeyValidator.sol` module instantly halt the action.
  3. UI displays **`🛑 CRYPTOGRAPHIC GUARDRAIL INTERCEPT: ACTION HALTED`** (`HTTP 403 Forbidden`).
* **Closing:**
  > "Prism 8 proves that autonomous AI agents can manage real on-chain capital when bounded by cryptographic code. We unite ERC-7579 modular account abstraction, Hedera x402 machine payments, The Graph data intelligence, and Superfluid continuous streaming into a single production-ready protocol. Thank you!"

---

## 🛠️ Rapid Demo Checklist for Presenter
- [ ] Next.js Storefront running on `http://localhost:3000/` (or Railway root)
- [ ] Hermes Console accessible at `http://localhost:3000/hermes`
- [ ] MetaMask connected (Ethereum Sepolia / Base Sepolia)
- [ ] Hedera Testnet account (HBAR testnet funds)
- [ ] All verification test suites verified (`npm run compile:contracts`, `npx tsc --noEmit`, `node scripts/test-session-policy.mjs`)
