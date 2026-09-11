// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/ISuperfluidCFA.sol";

/**
 * @title YieldVault
 * @notice Holds incoming rental stablecoins and maintains continuous per-second
 *         Superfluid CFA yield streams into verified investor accounts.
 */
contract YieldVault {
    address public owner;
    ISuperfluidToken public superToken; // fUSDCx on Base Sepolia
    ICFAv1Forwarder public cfaForwarder;

    struct InvestorStream {
        address investor;
        int96 flowRate;
        uint256 startedAt;
        bool isActive;
    }

    // propertyId => investor => InvestorStream
    mapping(bytes32 => mapping(address => InvestorStream)) public propertyInvestorStreams;
    // propertyId => list of active investor addresses
    mapping(bytes32 => address[]) private activeInvestors;
    // propertyId => total deposited rent
    mapping(bytes32 => uint256) public totalRentDeposited;

    event RentDeposited(bytes32 indexed propertyId, address indexed depositor, uint256 amount);
    event StreamOpened(bytes32 indexed propertyId, address indexed investor, int96 flowRate);
    event StreamUpdated(bytes32 indexed propertyId, address indexed investor, int96 newFlowRate);
    event StreamClosed(bytes32 indexed propertyId, address indexed investor);
    event PropertyStreamsFrozen(bytes32 indexed propertyId, uint256 closedCount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can call");
        _;
    }

    constructor(address _superToken, address _cfaForwarder) {
        owner = msg.sender;
        superToken = ISuperfluidToken(_superToken);
        cfaForwarder = ICFAv1Forwarder(_cfaForwarder);
    }

    function setCFAForwarder(address _forwarder) external onlyOwner {
        cfaForwarder = ICFAv1Forwarder(_forwarder);
    }

    function setSuperToken(address _superToken) external onlyOwner {
        superToken = ISuperfluidToken(_superToken);
    }

    /**
     * @notice Computes flow rate in wei per second given monthly rent (USD base with 18 decimals)
     *         and investor share in basis points (10000 = 100%).
     *         1 month = 30 days = 2,592,000 seconds.
     */
    function calculateFlowRate(uint256 monthlyRentUsd, uint256 shareBasisPoints) public pure returns (int96) {
        require(shareBasisPoints <= 10000, "Share exceeds 100%");
        uint256 monthlyInvestorPortion = (monthlyRentUsd * shareBasisPoints) / 10000;
        uint256 perSecond = monthlyInvestorPortion / 2592000;
        return int96(uint96(perSecond));
    }

    /**
     * @notice Deposit rental payment from tenant bridge into the vault reserve.
     */
    function depositRent(bytes32 propertyId, uint256 amount) external {
        require(amount > 0, "Amount must be positive");
        totalRentDeposited[propertyId] += amount;

        // If superToken is configured, pull tokens
        if (address(superToken) != address(0)) {
            require(superToken.transferFrom(msg.sender, address(this), amount), "Transfer failed");
        }

        emit RentDeposited(propertyId, msg.sender, amount);
    }

    /**
     * @notice Opens a per-second continuous yield stream to an investor.
     */
    function createInvestorStream(
        bytes32 propertyId,
        address investor,
        int96 flowRate
    ) external onlyOwner {
        require(investor != address(0), "Invalid investor address");
        require(flowRate > 0, "Flow rate must be positive");

        InvestorStream storage stream = propertyInvestorStreams[propertyId][investor];

        if (address(cfaForwarder) != address(0)) {
            if (stream.isActive) {
                cfaForwarder.updateFlow(superToken, address(this), investor, flowRate, "");
            } else {
                cfaForwarder.createFlow(superToken, address(this), investor, flowRate, "");
            }
        }

        if (!stream.isActive) {
            activeInvestors[propertyId].push(investor);
            stream.isActive = true;
            stream.investor = investor;
            stream.startedAt = block.timestamp;
            emit StreamOpened(propertyId, investor, flowRate);
        } else {
            emit StreamUpdated(propertyId, investor, flowRate);
        }

        stream.flowRate = flowRate;
    }

    /**
     * @notice Deletes an ongoing stream to an investor.
     */
    function deleteInvestorStream(bytes32 propertyId, address investor) external onlyOwner {
        InvestorStream storage stream = propertyInvestorStreams[propertyId][investor];
        require(stream.isActive, "Stream not active");

        if (address(cfaForwarder) != address(0)) {
            cfaForwarder.deleteFlow(superToken, address(this), investor, "");
        }

        stream.isActive = false;
        stream.flowRate = 0;
        emit StreamClosed(propertyId, investor);
    }

    /**
     * @notice Compliance trigger: terminates all active streams for a frozen/slashed property.
     */
    function emergencyFreezeAll(bytes32 propertyId) external onlyOwner returns (uint256 count) {
        address[] memory investors = activeInvestors[propertyId];
        uint256 closed = 0;

        for (uint256 i = 0; i < investors.length; i++) {
            address inv = investors[i];
            InvestorStream storage stream = propertyInvestorStreams[propertyId][inv];
            if (stream.isActive) {
                if (address(cfaForwarder) != address(0)) {
                    try cfaForwarder.deleteFlow(superToken, address(this), inv, "") {} catch {}
                }
                stream.isActive = false;
                stream.flowRate = 0;
                closed++;
                emit StreamClosed(propertyId, inv);
            }
        }

        delete activeInvestors[propertyId];
        emit PropertyStreamsFrozen(propertyId, closed);
        return closed;
    }

    function getActiveInvestors(bytes32 propertyId) external view returns (address[] memory) {
        return activeInvestors[propertyId];
    }
}
