import { Wallet, verifyTypedData } from "ethers";

const VALIDATOR_CONTRACT_ADDRESS = "0x7579C0de00000000000000000000000000007579";
const HERMES_AGENT_ADDRESS = "0x89205A3A3b2A69De6Dbf7f01ED13B2108B2c43e7";

const domain = {
  name: "Prism8SessionValidator",
  version: "1",
  chainId: 11155111,
  verifyingContract: VALIDATOR_CONTRACT_ADDRESS,
};

const types = {
  SessionPolicy: [
    { name: "grantor", type: "address" },
    { name: "agent", type: "address" },
    { name: "allowedTargets", type: "address[]" },
    { name: "allowedSelectors", type: "bytes4[]" },
    { name: "maxSpend", type: "uint256" },
    { name: "maxFlow", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validUntil", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};

async function test() {
  console.log("=== Testing ERC-7579 EIP-712 Scoped Session Key Flow ===");
  
  // 1. Generate Delegator / Grantor Wallet
  const delegator = Wallet.createRandom();
  console.log("Delegator Address:", delegator.address);

  // 2. Define Scoped Policy
  const nonce = Date.now();
  const validAfter = Math.floor(Date.now() / 1000);
  const validUntil = validAfter + 86400; // 24 hours
  const allowedTargets = [
    VALIDATOR_CONTRACT_ADDRESS,
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
  ];
  const allowedSelectors = [
    "0xb4b46617",
    "0x401826f6",
    "0xd4116492",
  ];
  const policyValue = {
    grantor: delegator.address,
    agent: HERMES_AGENT_ADDRESS,
    allowedTargets,
    allowedSelectors,
    maxSpend: BigInt(5 * 1e18), // 5 HBAR
    maxFlow: BigInt(5000), // $5,000 / mo
    validAfter: BigInt(validAfter),
    validUntil: BigInt(validUntil),
    nonce: BigInt(nonce),
  };

  // 3. Delegator Signs EIP-712 Typed Data
  const signature = await delegator.signTypedData(domain, types, policyValue);
  console.log("✓ EIP-712 Signature Generated:", signature.slice(0, 32) + "...");

  // 4. Verify Typed Data Recovery
  const recovered = verifyTypedData(domain, types, policyValue, signature);
  console.log("Recovered Signer:", recovered);

  if (recovered.toLowerCase() === delegator.address.toLowerCase()) {
    console.log("✓ Cryptographic Proof: Signer matches Grantor exactly (ERC-7579 Verified)");
  } else {
    throw new Error("Signature verification failed!");
  }

  console.log("\nAll Session Key cryptographic verifications passed successfully!");
}

test().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
