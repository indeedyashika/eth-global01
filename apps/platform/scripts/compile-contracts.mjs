import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const root = process.cwd();
const contractsDir = path.join(root, "contracts");
const generatedDir = path.join(root, "src", "lib", "evm", "generated");
fs.mkdirSync(generatedDir, { recursive: true });

const targetFiles = [
  "CompliantRwaToken.sol",
  "PropertyRegistry.sol",
  "YieldVault.sol",
  "USPSChainlinkConsumer.sol",
  "modules/SessionKeyValidator.sol",
];

function findImports(importPath) {
  const resolved = importPath.startsWith("@")
    ? path.join(root, "node_modules", importPath)
    : path.join(contractsDir, importPath);
  try {
    return { contents: fs.readFileSync(resolved, "utf8") };
  } catch (error) {
    return { error: `Unable to read ${importPath}: ${error.message}` };
  }
}

const sources = {};
for (const file of targetFiles) {
  const filePath = path.join(contractsDir, file);
  if (fs.existsSync(filePath)) {
    sources[file] = { content: fs.readFileSync(filePath, "utf8") };
  }
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      "*": { "*": ["abi", "evm.bytecode.object"] },
    },
  },
};

console.log("Compiling contracts:", Object.keys(sources).join(", "));
const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errors = (output.errors ?? []).filter((entry) => entry.severity === "error");
if (errors.length) {
  throw new Error(errors.map((entry) => entry.formattedMessage).join("\n"));
}

for (const [file, contractMap] of Object.entries(output.contracts ?? {})) {
  for (const [name, contract] of Object.entries(contractMap)) {
    // Only output top-level target contracts
    if (targetFiles.includes(file)) {
      const outputPath = path.join(generatedDir, `${name}.json`);
      fs.writeFileSync(
        outputPath,
        `${JSON.stringify({ abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` }, null, 2)}\n`
      );
      console.log(`✓ Compiled ${name} -> ${path.relative(root, outputPath)}`);
    }
  }
}

console.log("All contracts compiled successfully!");
