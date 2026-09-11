// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice ERC-20 counterpart to the platform's HTS token policy.
/// World ID proofs remain private and off-chain; the Hermes operator only writes
/// the resulting allowlist/freeze decision to this contract.
contract CompliantRwaToken is ERC20, ERC20Pausable, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant RECOVERY_ROLE = keccak256("RECOVERY_ROLE");

    uint8 private immutable _tokenDecimals;
    uint256 public immutable maxSupply;
    bool public immutable transferGateEnabled;
    bool public immutable freezeEnabled;
    bool public immutable pauseEnabled;
    bool public immutable recoveryEnabled;
    address public immutable treasury;

    mapping(address account => bool) public approved;
    mapping(address account => bool) public frozen;

    bool private _recoveryInProgress;

    error AccountNotApproved(address account);
    error AccountFrozen(address account);
    error RecoveryDisabled();
    error FreezeDisabled();
    error PauseDisabled();
    error MaxSupplyExceeded(uint256 requested, uint256 maximum);

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 initialSupply_,
        uint256 maxSupply_,
        bool transferGateEnabled_,
        bool freezeEnabled_,
        bool pauseEnabled_,
        bool recoveryEnabled_,
        address operator_
    ) ERC20(name_, symbol_) {
        require(operator_ != address(0), "operator required");
        require(maxSupply_ == 0 || initialSupply_ <= maxSupply_, "initial supply exceeds cap");
        _tokenDecimals = decimals_;
        maxSupply = maxSupply_;
        transferGateEnabled = transferGateEnabled_;
        freezeEnabled = freezeEnabled_;
        pauseEnabled = pauseEnabled_;
        recoveryEnabled = recoveryEnabled_;
        treasury = operator_;

        _grantRole(DEFAULT_ADMIN_ROLE, operator_);
        _grantRole(MINTER_ROLE, operator_);
        _grantRole(COMPLIANCE_ROLE, operator_);
        if (pauseEnabled_) _grantRole(PAUSER_ROLE, operator_);
        if (recoveryEnabled_) _grantRole(RECOVERY_ROLE, operator_);
        approved[operator_] = true;

        if (initialSupply_ > 0) _mint(operator_, initialSupply_);
    }

    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        if (maxSupply != 0 && totalSupply() + amount > maxSupply) {
            revert MaxSupplyExceeded(totalSupply() + amount, maxSupply);
        }
        _mint(to, amount);
    }

    function setApproved(address account, bool value) external onlyRole(COMPLIANCE_ROLE) {
        approved[account] = value;
    }

    function setFrozen(address account, bool value) external onlyRole(COMPLIANCE_ROLE) {
        if (!freezeEnabled) revert FreezeDisabled();
        frozen[account] = value;
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        if (!pauseEnabled) revert PauseDisabled();
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        if (!pauseEnabled) revert PauseDisabled();
        _unpause();
    }

    /// @notice Emergency/admin clawback matching HTS wipe semantics.
    function recover(address from, uint256 amount) external onlyRole(RECOVERY_ROLE) {
        if (!recoveryEnabled) revert RecoveryDisabled();
        _recoveryInProgress = true;
        _transfer(from, treasury, amount);
        _recoveryInProgress = false;
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Pausable) {
        if (!_recoveryInProgress && from != address(0) && to != address(0)) {
            if (from != treasury && frozen[from]) revert AccountFrozen(from);
            if (to != treasury && frozen[to]) revert AccountFrozen(to);
            if (transferGateEnabled) {
                if (from != treasury && !approved[from]) revert AccountNotApproved(from);
                if (to != treasury && !approved[to]) revert AccountNotApproved(to);
            }
        }
        super._update(from, to, value);
    }
}
