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
        "SessionPolicy(address grantor,address agent,address[] allowedTargets,bytes4[] allowedSelectors,uint256 maxSpend,uint256 maxFlow,uint256 validAfter,uint256 validUntil,uint256 nonce)"
    );

    struct SessionPolicy {
        address grantor;
        address agent;
        address[] allowedTargets;
        bytes4[] allowedSelectors;
        uint256 maxSpend;
        uint256 maxFlow;
        uint256 validAfter;
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
    // Grantor -> Nonce -> Used status
    mapping(address => mapping(uint256 => bool)) public usedNonces;
    // Grantor -> Agent -> Accumulated spend tracking (in base units)
    mapping(address => mapping(address => uint256)) public accumulatedSpend;
    // Grantor -> Agent -> Active flow rate tracking
    mapping(address => mapping(address => uint256)) public activeFlowRate;

    event SessionDelegated(
        address indexed grantor,
        address indexed agent,
        uint256 validAfter,
        uint256 validUntil,
        uint256 maxSpend,
        uint256 maxFlow,
        uint256 nonce
    );

    event SessionRevoked(address indexed grantor, uint256 indexed nonce);

    event ActionExecuted(
        address indexed grantor,
        address indexed agent,
        address indexed target,
        bytes4 selector,
        uint256 spendAmount
    );

    event FlowExecuted(
        address indexed grantor,
        address indexed agent,
        address indexed target,
        bytes4 selector,
        uint256 flowRate
    );

    error SessionNotYetValid(uint256 validAfter, uint256 currentTimestamp);
    error SessionExpired(uint256 validUntil, uint256 currentTimestamp);
    error SessionNonceUsed(address grantor, uint256 nonce);
    error SessionNonceRevoked(address grantor, uint256 nonce);
    error InvalidSigner(address expected, address recovered);
    error UnauthorizedAgent(address expected, address actual);
    error TargetNotAllowed(address target);
    error SelectorNotAllowed(bytes4 selector);
    error SpendLimitExceeded(uint256 requested, uint256 remaining);
    error FlowLimitExceeded(uint256 requested, uint256 maxFlow);

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
     * @notice Computes the EIP-712 array hash for an address[] array according to EIP-712 specification.
     */
    function hashAddressArray(address[] memory arr) public pure returns (bytes32) {
        bytes32[] memory encoded = new bytes32[](arr.length);
        for (uint256 i = 0; i < arr.length; i++) {
            encoded[i] = bytes32(uint256(uint160(arr[i])));
        }
        return keccak256(abi.encodePacked(encoded));
    }

    /**
     * @notice Computes the EIP-712 array hash for a bytes4[] array according to EIP-712 specification.
     */
    function hashSelectorArray(bytes4[] memory arr) public pure returns (bytes32) {
        bytes32[] memory encoded = new bytes32[](arr.length);
        for (uint256 i = 0; i < arr.length; i++) {
            encoded[i] = bytes32(arr[i]);
        }
        return keccak256(abi.encodePacked(encoded));
    }

    /**
     * @notice Computes the EIP-712 digest for a given SessionPolicy.
     */
    function hashPolicy(SessionPolicy memory policy) public view returns (bytes32) {
        bytes32 targetsHash = hashAddressArray(policy.allowedTargets);
        bytes32 selectorsHash = hashSelectorArray(policy.allowedSelectors);

        bytes32 structHash = keccak256(
            abi.encode(
                SESSION_POLICY_TYPEHASH,
                policy.grantor,
                policy.agent,
                targetsHash,
                selectorsHash,
                policy.maxSpend,
                policy.maxFlow,
                policy.validAfter,
                policy.validUntil,
                policy.nonce
            )
        );
        return _hashTypedDataV4(structHash);
    }

    /**
     * @notice Checks whether a target address is allowed by the session policy.
     */
    function isTargetAllowed(SessionPolicy memory policy, address target) public pure returns (bool) {
        for (uint256 i = 0; i < policy.allowedTargets.length; i++) {
            if (policy.allowedTargets[i] == target) return true;
        }
        return false;
    }

    /**
     * @notice Checks whether a function selector is allowed by the session policy.
     */
    function isSelectorAllowed(SessionPolicy memory policy, bytes4 selector) public pure returns (bool) {
        for (uint256 i = 0; i < policy.allowedSelectors.length; i++) {
            if (policy.allowedSelectors[i] == selector) return true;
        }
        return false;
    }

    /**
     * @notice Validates a session policy signature and state against its grantor.
     */
    function validateSession(
        SessionPolicy memory policy,
        bytes memory signature
    ) public view returns (bool) {
        if (block.timestamp < policy.validAfter) {
            revert SessionNotYetValid(policy.validAfter, block.timestamp);
        }
        if (block.timestamp > policy.validUntil) {
            revert SessionExpired(policy.validUntil, block.timestamp);
        }
        if (usedNonces[policy.grantor][policy.nonce]) {
            revert SessionNonceUsed(policy.grantor, policy.nonce);
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
     * @notice Checks policy validity, verifies target, selector, and records spend on-chain.
     */
    function checkAndRecordSpend(
        SessionPolicy calldata policy,
        bytes calldata signature,
        address target,
        bytes4 selector,
        uint256 spendAmount
    ) public returns (bool) {
        validateSession(policy, signature);

        if (msg.sender != policy.agent) {
            revert UnauthorizedAgent(policy.agent, msg.sender);
        }

        if (!isTargetAllowed(policy, target)) {
            revert TargetNotAllowed(target);
        }

        if (!isSelectorAllowed(policy, selector)) {
            revert SelectorNotAllowed(selector);
        }

        uint256 currentSpend = accumulatedSpend[policy.grantor][policy.agent];
        if (currentSpend + spendAmount > policy.maxSpend) {
            revert SpendLimitExceeded(spendAmount, policy.maxSpend - currentSpend);
        }

        accumulatedSpend[policy.grantor][policy.agent] = currentSpend + spendAmount;
        emit ActionExecuted(policy.grantor, policy.agent, target, selector, spendAmount);
        return true;
    }

    /**
     * @notice Backwards-compatible spend recording overload using default target/selector.
     */
    function checkAndRecordSpend(
        SessionPolicy calldata policy,
        bytes calldata signature,
        uint256 spendAmount
    ) external returns (bool) {
        address target = policy.allowedTargets.length > 0 ? policy.allowedTargets[0] : address(0);
        bytes4 selector = policy.allowedSelectors.length > 0 ? policy.allowedSelectors[0] : bytes4(0);
        return checkAndRecordSpend(policy, signature, target, selector, spendAmount);
    }

    /**
     * @notice Checks policy validity, verifies target, selector, and records flow rate on-chain.
     */
    function checkAndRecordFlow(
        SessionPolicy calldata policy,
        bytes calldata signature,
        address target,
        bytes4 selector,
        uint256 flowRate
    ) external returns (bool) {
        validateSession(policy, signature);

        if (msg.sender != policy.agent) {
            revert UnauthorizedAgent(policy.agent, msg.sender);
        }

        if (!isTargetAllowed(policy, target)) {
            revert TargetNotAllowed(target);
        }

        if (!isSelectorAllowed(policy, selector)) {
            revert SelectorNotAllowed(selector);
        }

        if (flowRate > policy.maxFlow) {
            revert FlowLimitExceeded(flowRate, policy.maxFlow);
        }

        activeFlowRate[policy.grantor][policy.agent] = flowRate;
        emit FlowExecuted(policy.grantor, policy.agent, target, selector, flowRate);
        return true;
    }

    function _sliceSelector(bytes memory b, uint256 offset) internal pure returns (bytes4 sel) {
        if (b.length >= offset + 4) {
            assembly {
                sel := mload(add(add(b, 0x20), offset))
            }
        }
    }

    function _sliceAddress(bytes memory b, uint256 offset) internal pure returns (address addr) {
        if (b.length >= offset + 20) {
            bytes32 val;
            assembly {
                val := mload(add(add(b, 0x20), offset))
            }
            addr = address(uint160(uint256(val) >> 96));
        }
    }

    function _sliceUint256(bytes memory b, uint256 offset) internal pure returns (uint256 val) {
        if (b.length >= offset + 32) {
            assembly {
                val := mload(add(add(b, 0x20), offset))
            }
        }
    }

    /**
     * @notice Standard ERC-4337 UserOperation validation for modular accounts.
     * Decodes session policy, grantor signature, and agent signature from userOp.signature.
     */
    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash
    ) external view returns (uint256 validationData) {
        if (userOp.signature.length < 192) {
            return 1; // SIG_VALIDATION_FAILED
        }

        (SessionPolicy memory policy, bytes memory grantorSig, bytes memory agentSig) = abi.decode(
            userOp.signature,
            (SessionPolicy, bytes, bytes)
        );

        if (userOp.sender != policy.grantor) {
            return 1;
        }

        if (block.timestamp < policy.validAfter || block.timestamp > policy.validUntil) {
            return 1;
        }

        if (revokedNonces[policy.grantor][policy.nonce] || usedNonces[policy.grantor][policy.nonce]) {
            return 1;
        }

        // Verify grantor signature over SessionPolicy
        bytes32 digest = hashPolicy(policy);
        address recoveredGrantor = digest.recover(grantorSig);
        if (recoveredGrantor != policy.grantor) {
            return 1;
        }

        // Verify agent signature over userOpHash
        address recoveredAgent = userOpHash.recover(agentSig);
        if (recoveredAgent != policy.agent) {
            return 1;
        }

        // Inspect execution callData if present
        if (userOp.callData.length >= 4) {
            bytes4 execSelector = bytes4(userOp.callData[:4]);
            address callTarget;
            uint256 callValue;
            bytes4 callSelector;

            // Check standard execute(address,uint256,bytes) selector 0xb61d27f6
            if (execSelector == 0xb61d27f6 && userOp.callData.length >= 68) {
                callTarget = abi.decode(userOp.callData[4:36], (address));
                callValue = abi.decode(userOp.callData[36:68], (uint256));
                if (userOp.callData.length >= 100) {
                    bytes memory innerData = abi.decode(userOp.callData[68:], (bytes));
                    callSelector = _sliceSelector(innerData, 0);
                }
                if (!isTargetAllowed(policy, callTarget)) return 1;
                if (callSelector != bytes4(0) && !isSelectorAllowed(policy, callSelector)) return 1;
                if (callValue > policy.maxSpend) return 1;
            }
            // Check ERC-7579 execute(bytes32,bytes) selector 0xe9ae5c53
            else if (execSelector == 0xe9ae5c53 && userOp.callData.length >= 68) {
                bytes memory executionCalldata = abi.decode(userOp.callData[36:], (bytes));
                if (executionCalldata.length >= 52) {
                    callTarget = _sliceAddress(executionCalldata, 0);
                    callValue = _sliceUint256(executionCalldata, 20);
                    callSelector = _sliceSelector(executionCalldata, 52);
                    if (!isTargetAllowed(policy, callTarget)) return 1;
                    if (callSelector != bytes4(0) && !isSelectorAllowed(policy, callSelector)) return 1;
                    if (callValue > policy.maxSpend) return 1;
                }
            }
        }

        return 0; // SUCCESS
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
     * @notice Marks a session nonce as used on-chain to prevent replay.
     */
    function recordSessionNonce(uint256 nonce) external {
        if (usedNonces[msg.sender][nonce]) {
            revert SessionNonceUsed(msg.sender, nonce);
        }
        usedNonces[msg.sender][nonce] = true;
    }

    /**
     * @notice Allows a grantor to immediately revoke a session key nonce.
     */
    function revokeSessionNonce(uint256 nonce) external {
        revokedNonces[msg.sender][nonce] = true;
        emit SessionRevoked(msg.sender, nonce);
    }
}
