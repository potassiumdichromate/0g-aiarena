// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title ModuleMarketplace
 * @notice Marketplace for buying and selling AI agent modules (skills, behaviours, adapters).
 * @dev Stub implementation - full version to be implemented.
 */
contract ModuleMarketplace is Ownable {
    struct Module {
        string moduleId;
        string name;
        string description;
        string ipfsHash;      // IPFS/0G Storage hash of module code
        address creator;
        uint256 price;        // Price in ARENA tokens (18 decimals)
        uint256 purchaseCount;
        bool isActive;
    }

    mapping(string => Module) public modules;
    mapping(address => mapping(string => bool)) public purchases;

    event ModuleListed(string indexed moduleId, address creator, uint256 price);
    event ModulePurchased(string indexed moduleId, address buyer);

    constructor() Ownable(msg.sender) {}

    function listModule(
        string calldata moduleId,
        string calldata name,
        string calldata description,
        string calldata ipfsHash,
        uint256 price
    ) external {
        require(bytes(modules[moduleId].moduleId).length == 0, "Module already listed");

        modules[moduleId] = Module({
            moduleId: moduleId,
            name: name,
            description: description,
            ipfsHash: ipfsHash,
            creator: msg.sender,
            price: price,
            purchaseCount: 0,
            isActive: true
        });

        emit ModuleListed(moduleId, msg.sender, price);
    }

    function purchaseModule(string calldata moduleId) external payable {
        Module storage mod = modules[moduleId];
        require(mod.isActive, "Module not available");
        require(!purchases[msg.sender][moduleId], "Already purchased");
        require(msg.value >= mod.price, "Insufficient payment");

        purchases[msg.sender][moduleId] = true;
        mod.purchaseCount += 1;

        // Transfer to creator
        payable(mod.creator).transfer(mod.price);

        emit ModulePurchased(moduleId, msg.sender);
    }

    function hasPurchased(address buyer, string calldata moduleId) external view returns (bool) {
        return purchases[buyer][moduleId];
    }
}
