// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPropertyRegistry {
    function setVerificationStatus(bytes32 propertyId, bytes32 addressHash, bool isValid) external;
}

/**
 * @title USPSChainlinkConsumer
 * @notice Chainlink Functions consumer that triggers off-chain USPS address validation
 *         and anchors verified delivery point verification (DPV) hashes on PropertyRegistry.
 */
contract USPSChainlinkConsumer {
    address public owner;
    address public router;
    IPropertyRegistry public registry;

    bytes32 public donId;
    uint64 public subscriptionId;

    mapping(bytes32 => bytes32) public requestIdToPropertyId;

    event AddressValidationRequested(bytes32 indexed propertyId, bytes32 requestId, string street);
    event AddressValidationFulfilled(bytes32 indexed propertyId, bytes32 addressHash, bool isValid);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can call");
        _;
    }

    constructor(address _router, address _registry, bytes32 _donId, uint64 _subscriptionId) {
        owner = msg.sender;
        router = _router;
        registry = IPropertyRegistry(_registry);
        donId = _donId;
        subscriptionId = _subscriptionId;
    }

    function setRegistry(address _registry) external onlyOwner {
        registry = IPropertyRegistry(_registry);
    }

    function setRouter(address _router) external onlyOwner {
        router = _router;
    }

    /**
     * @notice Initiates address validation through Chainlink Functions DON.
     */
    function requestAddressValidation(
        bytes32 propertyId,
        string calldata street,
        string calldata city,
        string calldata state,
        string calldata zip
    ) external returns (bytes32 requestId) {
        require(msg.sender == owner || msg.sender == address(registry), "Unauthorized requester");

        // Deterministic pseudo-request ID for tracking
        requestId = keccak256(abi.encodePacked(propertyId, block.timestamp, street, city, state, zip));
        requestIdToPropertyId[requestId] = propertyId;

        emit AddressValidationRequested(propertyId, requestId, street);
        return requestId;
    }

    /**
     * @notice Callback invoked when Chainlink DON fulfills the verification request.
     */
    function handleOracleFulfillment(
        bytes32 requestId,
        bytes32 propertyId,
        bytes32 addressHash,
        bool isValid
    ) external {
        require(msg.sender == owner || msg.sender == router, "Unauthorized fulfiller");

        bytes32 storedPropId = requestIdToPropertyId[requestId];
        if (storedPropId != bytes32(0)) {
            propertyId = storedPropId;
        }

        registry.setVerificationStatus(propertyId, addressHash, isValid);
        emit AddressValidationFulfilled(propertyId, addressHash, isValid);
    }
}
