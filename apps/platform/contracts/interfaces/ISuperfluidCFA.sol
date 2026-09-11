// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ISuperfluidToken {
    function transfer(address recipient, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    function upgrade(uint256 amount) external;
    function downgrade(uint256 amount) external;
}

interface IConstantFlowAgreementV1 {
    function createFlow(
        ISuperfluidToken token,
        address receiver,
        int96 flowRate,
        bytes calldata ctx
    ) external returns (bytes memory newCtx);

    function updateFlow(
        ISuperfluidToken token,
        address receiver,
        int96 flowRate,
        bytes calldata ctx
    ) external returns (bytes memory newCtx);

    function deleteFlow(
        ISuperfluidToken token,
        address sender,
        address receiver,
        bytes calldata ctx
    ) external returns (bytes memory newCtx);

    function getFlow(
        ISuperfluidToken token,
        address sender,
        address receiver
    ) external view returns (uint256 timestamp, int96 flowRate, uint256 deposit, uint256 owedDeposit);
}

interface ICFAv1Forwarder {
    function createFlow(
        ISuperfluidToken token,
        address sender,
        address receiver,
        int96 flowRate,
        bytes memory userData
    ) external returns (bool);

    function updateFlow(
        ISuperfluidToken token,
        address sender,
        address receiver,
        int96 flowRate,
        bytes memory userData
    ) external returns (bool);

    function deleteFlow(
        ISuperfluidToken token,
        address sender,
        address receiver,
        bytes memory userData
    ) external returns (bool);

    function getFlowrate(
        ISuperfluidToken token,
        address sender,
        address receiver
    ) external view returns (int96 flowRate);
}
