// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title AgentRegistry
 * @notice On-chain registry mapping agent IDs to INFT token IDs and game statistics.
 */
contract AgentRegistry is Ownable {
    struct AgentRecord {
        string agentId;
        uint256 tokenId;
        address owner;
        int32 eloRating;
        bool isActive;
        uint256 registeredAt;
    }

    mapping(string => AgentRecord) public agents;
    mapping(uint256 => string) public tokenIdToAgentId;
    mapping(address => string[]) public ownerAgents;

    event AgentRegistered(string indexed agentId, uint256 tokenId, address owner);
    event EloUpdated(string indexed agentId, int32 newElo);
    event AgentDeactivated(string indexed agentId);

    constructor() Ownable(msg.sender) {}

    function registerAgent(
        string calldata agentId,
        uint256 tokenId,
        address owner,
        int32 initialElo
    ) external onlyOwner {
        require(agents[agentId].tokenId == 0, "Agent already registered");

        agents[agentId] = AgentRecord({
            agentId: agentId,
            tokenId: tokenId,
            owner: owner,
            eloRating: initialElo,
            isActive: true,
            registeredAt: block.timestamp
        });

        tokenIdToAgentId[tokenId] = agentId;
        ownerAgents[owner].push(agentId);

        emit AgentRegistered(agentId, tokenId, owner);
    }

    function updateElo(string calldata agentId, int32 newElo) external onlyOwner {
        require(agents[agentId].isActive, "Agent not active");
        agents[agentId].eloRating = newElo;
        emit EloUpdated(agentId, newElo);
    }

    function deactivateAgent(string calldata agentId) external onlyOwner {
        agents[agentId].isActive = false;
        emit AgentDeactivated(agentId);
    }

    function getAgentsByOwner(address owner) external view returns (string[] memory) {
        return ownerAgents[owner];
    }
}
