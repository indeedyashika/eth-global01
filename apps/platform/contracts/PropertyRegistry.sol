// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title PropertyRegistry
 * @notice Canonical registry linking physical real estate assets, USPS Chainlink verification
 *         hashes, Hedera HTS token identifiers, and compliance statuses.
 */
contract PropertyRegistry {
    enum PropertyStatus {
        PENDING,   // Address registered, awaiting USPS oracle verification
        VERIFIED,  // USPS confirmed address deliverability (DPV "Y")
        ACTIVE,    // HTS tokens minted, rental streams active
        FROZEN,    // Compliance freeze triggered by Hermes or oracle
        SLASHED    // Title or address fraud detected; collateral slashed
    }

    struct Property {
        bytes32 propertyId;
        bytes32 addressHash;
        bool uspsVerified;
        string hederaTokenId;
        PropertyStatus status;
        bool isSlashable;
        uint256 monthlyRentUsd;
        address vaultAddress;
        uint256 registeredAt;
        uint256 verifiedAt;
    }

    address public owner;
    address public authorizedOracle;

    mapping(bytes32 => Property) public properties;
    bytes32[] public propertyIds;

    event PropertyRegistered(bytes32 indexed propertyId, string hederaTokenId, uint256 monthlyRentUsd);
    event PropertyVerified(bytes32 indexed propertyId, bytes32 addressHash, bool isValid);
    event PropertyStatusUpdated(bytes32 indexed propertyId, PropertyStatus oldStatus, PropertyStatus newStatus);
    event VaultLinked(bytes32 indexed propertyId, address vaultAddress);
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can call");
        _;
    }

    modifier onlyAuthorized() {
        require(msg.sender == owner || msg.sender == authorizedOracle, "Not authorized to verify");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setAuthorizedOracle(address _oracle) external onlyOwner {
        emit OracleUpdated(authorizedOracle, _oracle);
        authorizedOracle = _oracle;
    }

    function registerProperty(
        bytes32 propertyId,
        string calldata hederaTokenId,
        uint256 monthlyRentUsd,
        bool isSlashable
    ) external onlyOwner {
        require(properties[propertyId].propertyId == bytes32(0), "Property already registered");

        properties[propertyId] = Property({
            propertyId: propertyId,
            addressHash: bytes32(0),
            uspsVerified: false,
            hederaTokenId: hederaTokenId,
            status: PropertyStatus.PENDING,
            isSlashable: isSlashable,
            monthlyRentUsd: monthlyRentUsd,
            vaultAddress: address(0),
            registeredAt: block.timestamp,
            verifiedAt: 0
        });

        propertyIds.push(propertyId);
        emit PropertyRegistered(propertyId, hederaTokenId, monthlyRentUsd);
    }

    function setVerificationStatus(
        bytes32 propertyId,
        bytes32 addressHash,
        bool isValid
    ) external onlyAuthorized {
        Property storage prop = properties[propertyId];
        require(prop.propertyId != bytes32(0), "Property not found");

        prop.addressHash = addressHash;
        prop.uspsVerified = isValid;
        prop.verifiedAt = block.timestamp;

        if (isValid) {
            prop.status = PropertyStatus.VERIFIED;
        } else {
            prop.status = PropertyStatus.FROZEN;
        }

        emit PropertyVerified(propertyId, addressHash, isValid);
    }

    function updatePropertyStatus(bytes32 propertyId, PropertyStatus newStatus) external onlyOwner {
        Property storage prop = properties[propertyId];
        require(prop.propertyId != bytes32(0), "Property not found");

        PropertyStatus oldStatus = prop.status;
        prop.status = newStatus;
        emit PropertyStatusUpdated(propertyId, oldStatus, newStatus);
    }

    function setVaultAddress(bytes32 propertyId, address vaultAddress) external onlyOwner {
        Property storage prop = properties[propertyId];
        require(prop.propertyId != bytes32(0), "Property not found");

        prop.vaultAddress = vaultAddress;
        emit VaultLinked(propertyId, vaultAddress);
    }

    function getProperty(bytes32 propertyId) external view returns (Property memory) {
        require(properties[propertyId].propertyId != bytes32(0), "Property not found");
        return properties[propertyId];
    }

    function totalProperties() external view returns (uint256) {
        return propertyIds.length;
    }
}
