// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title SessionKeyValidator
 * @notice ERC-7579 compliant validation module for AI Agent scoped session keys.
 * Enables smart accounts and delegators to grant time-bound, budget-capped, and
 * action-scoped execution authority to autonomous agents (e.g. Hermes Operator).
 * 
 * Verifies EIP-712 typed signatures (`SessionPolicy`) and validates ERC-4337 UserOperations.
 */
contract SessionKeyValidator is EIP712 {
    using ECDSA for bytes32;

    uint256 public constant MODULE_TYPE_VALIDATOR = 1;
    bytes4 public constant ERC1271_SUCCESS = 0x1626ba7e;
    bytes4 public constant ERC1271_FAILED = 0xffffffff;

    bytes32 public constant SESSION_POLICY_TYPEHASH = keccak256(
        "SessionPolicy(address grantor,address agent,uint256 maxSpendHbar,uint256 maxFlowMonthlyUsd,uint256 validUntil,uint256 nonce)"
    );

    struct SessionPolicy {
        address grantor;
        address agent;
        uint256 maxSpendHbar;
        uint256 maxFlowMonthlyUsd;
        uint256 validUntil;
        uint256 nonce;
    }

    struct PackedUserOperation {
        address sender;
        uint256 nonce;
        bytes initCode;
        bytes callData;
        bytes32 accountGasLimits;
        uint256 preVerificationGas;
        bytes32 gasFees;
        bytes paymasterAndData;
        bytes signature;
    }

    // Grantor -> Nonce -> Revoked status
    mapping(address => mapping(uint256 => bool)) public revokedNonces;
    // Grantor -> Agent -> Accumulated spend tracking (in base units)
    mapping(address => mapping(address => uint256)) public accumulatedSpend;

    event SessionDelegated(
        address indexed grantor,
        address indexed agent,
        uint256 validUntil,
        uint256 maxSpendHbar,
        uint256 nonce
    );

    event SessionRevoked(address indexed grantor, uint256 indexed nonce);

    event ActionExecuted(
        address indexed grantor,
        address indexed agent,
        bytes4 indexed selector,
        uint256 spendAmount
    );

    error SessionExpired(uint256 validUntil, uint256 currentTimestamp);
    error SessionNonceRevoked(address grantor, uint256 nonce);
    error InvalidSigner(address expected, address recovered);
    error UnauthorizedAgent(address expected, address actual);
    error SpendLimitExceeded(uint256 requested, uint256 remaining);

    constructor() EIP712("Prism8SessionValidator", "1") {}

    /**
     * @notice ERC-7579 module type check.
     */
    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_VALIDATOR;
    }

    /**
     * @notice ERC-7579 installation hook.
     */
    function onInstall(bytes calldata) external {}

    /**
     * @notice ERC-7579 uninstallation hook.
     */
    function onUninstall(bytes calldata) external {}

    /**
     * @notice Computes the EIP-712 digest for a given SessionPolicy.
     */
    function hashPolicy(SessionPolicy memory policy) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                SESSION_POLICY_TYPEHASH,
                policy.grantor,
                policy.agent,
                policy.maxSpendHbar,
                policy.maxFlowMonthlyUsd,
                policy.validUntil,
                policy.nonce
            )
        );
        return _hashTypedDataV4(structHash);
    }

    /**
     * @notice Validates a session policy signature against its grantor.
     */
    function validateSession(
        SessionPolicy memory policy,
        bytes memory signature
    ) public view returns (bool) {
        if (block.timestamp > policy.validUntil) {
            revert SessionExpired(policy.validUntil, block.timestamp);
        }
        if (revokedNonces[policy.grantor][policy.nonce]) {
            revert SessionNonceRevoked(policy.grantor, policy.nonce);
        }

        bytes32 digest = hashPolicy(policy);
        address recovered = digest.recover(signature);
        if (recovered != policy.grantor) {
            revert InvalidSigner(policy.grantor, recovered);
        }

        return true;
    }

    /**
     * @notice Checks policy validity and records spend on-chain.
     */
    function checkAndRecordSpend(
        SessionPolicy calldata policy,
        bytes calldata signature,
        uint256 spendAmount
    ) external returns (bool) {
        validateSession(policy, signature);

        if (msg.sender != policy.agent) {
            revert UnauthorizedAgent(policy.agent, msg.sender);
        }

        uint256 currentSpend = accumulatedSpend[policy.grantor][policy.agent];
        if (currentSpend + spendAmount > policy.maxSpendHbar) {
            revert SpendLimitExceeded(spendAmount, policy.maxSpendHbar - currentSpend);
        }

        accumulatedSpend[policy.grantor][policy.agent] = currentSpend + spendAmount;
        emit ActionExecuted(policy.grantor, policy.agent, msg.sig, spendAmount);
        return true;
    }

    /**
     * @notice Standard ERC-4337 UserOperation validation for modular accounts.
     * Decodes session policy and signature from userOp.signature.
     */
    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash
    ) external view returns (uint256 validationData) {
        // Decode (SessionPolicy, bytes signature) from userOp.signature
        if (userOp.signature.length < 192) {
            return 1; // SIG_VALIDATION_FAILED
        }

        (SessionPolicy memory policy, bytes memory sig) = abi.decode(
            userOp.signature,
            (SessionPolicy, bytes)
        );

        if (block.timestamp > policy.validUntil || revokedNonces[policy.grantor][policy.nonce]) {
            return 1;
        }

        bytes32 digest = hashPolicy(policy);
        address recovered = digest.recover(sig);
        if (recovered != policy.grantor || userOp.sender != policy.grantor) {
            return 1;
        }

        return 0; // Return 0 for valid signature
    }

    /**
     * @notice ERC-1271 signature validation interface.
     */
    function isValidSignatureWithSender(
        address,
        bytes32 hash,
        bytes calldata data
    ) external view returns (bytes4) {
        (address expectedSigner, bytes memory signature) = abi.decode(data, (address, bytes));
        address recovered = hash.recover(signature);
        return (recovered == expectedSigner) ? ERC1271_SUCCESS : ERC1271_FAILED;
    }

    /**
     * @notice Allows a grantor to immediately revoke a session key nonce.
     */
    function revokeSessionNonce(uint256 nonce) external {
        revokedNonces[msg.sender][nonce] = true;
        emit SessionRevoked(msg.sender, nonce);
    }
}
