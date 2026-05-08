// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Counters.sol";

/**
 * @title IERC7857
 * @notice Minimal ERC-7857 interface for Intelligent NFTs (INFTs).
 *         ERC-7857 extends ERC-721 with encrypted metadata transfer,
 *         cloning, and usage authorisation for AI agents.
 *
 * Reference: https://docs.0g.ai/developer-hub/building-on-0g/inft/erc7857
 * GitHub:    https://github.com/0gfoundation/0g-agent-nft
 *
 * Key operations:
 *   transfer()       — ownership + encrypted metadata handover via oracle TEE re-encryption
 *   clone()          — copy agent with identical metadata (AI-as-a-Service model)
 *   authorizeUsage() — grant usage rights without transferring ownership
 */
interface IERC7857 {
    // ── Events ────────────────────────────────────────────────────────────────

    /// @notice Emitted when encrypted metadata root hash changes
    event MetadataUpdated(uint256 indexed tokenId, bytes32 metadataHash);

    /// @notice Emitted when a third-party executor is granted usage rights
    event UsageAuthorized(uint256 indexed tokenId, address indexed executor, bytes permissions);

    /// @notice Emitted when the oracle configuration is updated
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);

    // ── Core ERC-7857 functions ───────────────────────────────────────────────

    /**
     * @notice Transfer ownership with re-encrypted metadata.
     *         The oracle (TEE) decrypts metadata with current owner's key,
     *         re-encrypts with `to`'s public key, and provides `proof`.
     *         `sealedKey` is the AES key sealed for the new owner.
     *
     * @param from      Current owner
     * @param to        New owner
     * @param tokenId   Token identifier
     * @param sealedKey AES-256-GCM key sealed for `to` using ECIES
     * @param proof     Oracle attestation proof (TEE or ZKP)
     */
    function transfer(
        address from,
        address to,
        uint256 tokenId,
        bytes calldata sealedKey,
        bytes calldata proof
    ) external;

    /**
     * @notice Clone the INFT, giving `to` a token with identical AI metadata.
     *         The original owner retains their copy.
     *         Used for AI-as-a-Service and delegation patterns.
     *
     * @param to        Recipient of the clone
     * @param tokenId   Token to clone
     * @param sealedKey AES key sealed for `to`
     * @param proof     Oracle proof authorising the clone
     * @return newTokenId The newly minted clone token ID
     */
    function clone(
        address to,
        uint256 tokenId,
        bytes calldata sealedKey,
        bytes calldata proof
    ) external returns (uint256 newTokenId);

    /**
     * @notice Grant an executor address rights to use the AI agent
     *         without transferring ownership.
     *         Example: rent agent to a tournament contract.
     *
     * @param tokenId     Token whose agent is being licensed
     * @param executor    Address authorised to invoke agent services
     * @param permissions ABI-encoded permission struct (scopes, expiry, etc.)
     */
    function authorizeUsage(
        uint256 tokenId,
        address executor,
        bytes calldata permissions
    ) external;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * @title AIArenaINFT
 * @notice Intelligent NFT (INFT) for AI Arena autonomous agents.
 *
 * Implements ERC-7857 on top of ERC-721 for AI agent tokenisation on 0G Chain.
 *
 * Key design decisions:
 *   1. Encrypted metadata: sensitive AI model weights + memory roots are AES-256-GCM
 *      encrypted and stored on 0G Storage. Only the root hash + sealed key live on-chain.
 *   2. Oracle-mediated transfers: the 0G oracle (TEE) re-encrypts metadata for new owners,
 *      producing a cryptographic proof verified in transfer().
 *   3. Dynamic metadata: evolution stage, battle stats, memory root, and model version
 *      all update on-chain after each training cycle and battle.
 *   4. Clone support: agent models can be cloned for AI-as-a-Service without losing original.
 *
 * Storage pattern (0G Storage):
 *   Metadata URI points to root hash on 0G Storage.
 *   Encrypted blob path: /agents/{agentId}/identity/genesis_block.json.enc
 *   Memory root: /agents/{agentId}/memory/  (indexed by memoryRootHash)
 *   Model weights: /agents/{agentId}/weights/lora_v{n}/adapter_model.safetensors
 *
 * Deployed on: 0G Chain (Chain ID 16661 mainnet / 16600 testnet)
 * Explorer: https://chainscan.0g.ai
 */
contract AIArenaINFT is IERC7857, ERC721, ERC721URIStorage, ERC721Enumerable, Ownable {
    using Counters for Counters.Counter;

    // ── Events ─────────────────────────────────────────────────────────────────

    event AgentMinted(uint256 indexed tokenId, string agentId, address indexed owner, string clan);
    event AgentEvolved(uint256 indexed tokenId, uint8 fromStage, uint8 toStage);
    event BattleResultRecorded(uint256 indexed tokenId, bool won, uint32 totalBattles);
    event MemoryRootUpdated(uint256 indexed tokenId, bytes32 memoryRoot);
    event ModelVersionUpdated(uint256 indexed tokenId, string modelRootHash);
    event AgentCloned(uint256 indexed parentId, uint256 indexed cloneId, address to);
    event TraitsUpdated(uint256 indexed tokenId);
    event UsageRevoked(uint256 indexed tokenId, address indexed executor);

    // ── Structs ────────────────────────────────────────────────────────────────

    struct AgentTraits {
        uint8 aggression;    // 0-100
        uint8 patience;      // 0-100
        uint8 adaptability;  // 0-100
        uint8 riskTolerance; // 0-100
        uint8 precision;     // 0-100
        uint8 endurance;     // 0-100
        uint8 creativity;    // 0-100
        uint8 teamwork;      // 0-100
    }

    struct AgentMetadata {
        string   agentId;            // Off-chain platform UUID
        string   clan;               // solana | base | 0g
        string   archetype;          // berserker | tactician | defender | sniper | hybrid
        uint8    evolutionStage;     // 1=Genesis, 2=Recruit, 3=Veteran, 4=Elite, 5=Legend
        uint32   wins;
        uint32   losses;
        uint32   draws;
        uint32   totalBattles;
        // 0G Storage root hashes (content-addressed)
        bytes32  memoryRootHash;     // Merkle root hash of agent memory tree in 0G Storage
        string   modelRootHash;      // 0G Storage root hash for active LoRA adapter
        string   genesisRootHash;    // 0G Storage root hash for genesis record (immutable)
        // Encrypted metadata (ERC-7857 pattern)
        bytes32  encryptedMetadataHash; // Keccak256 of encrypted metadata blob
        bytes    sealedKey;          // AES key sealed for current owner (ECIES)
        // Timestamps
        uint256  mintedAt;
        uint256  lastEvolvedAt;
        uint256  lastBattleAt;
        uint256  lastTrainingAt;
        // Traits
        AgentTraits traits;
    }

    struct UsagePermissions {
        address executor;
        uint256 expiresAt;      // 0 = no expiry
        bytes32 scopeHash;      // Keccak256 of allowed action list
        bool    active;
    }

    // ── State ──────────────────────────────────────────────────────────────────

    Counters.Counter private _tokenIdCounter;

    /// @dev platform-uuid → tokenId (for fast lookup)
    mapping(string  => uint256) public agentIdToTokenId;
    /// @dev tokenId → full metadata
    mapping(uint256 => AgentMetadata) public agentMetadata;
    /// @dev tokenId → executor → permissions
    mapping(uint256 => mapping(address => UsagePermissions)) public usagePermissions;
    /// @dev tokenId → parent tokenId (for clones; 0 = original)
    mapping(uint256 => uint256) public cloneParent;
    /// @dev tokenId → clone count
    mapping(uint256 => uint256) public cloneCount;

    /// @dev Service accounts permitted to update agent metadata
    mapping(address => bool) public authorisedOperators;

    /// @dev Oracle address for TEE re-encryption proofs (ERC-7857)
    address public oracle;

    uint256 public constant MAX_SUPPLY   = 100_000;
    uint256 public constant MAX_CLONES   = 3;

    // ── Modifiers ──────────────────────────────────────────────────────────────

    modifier onlyOperator() {
        require(
            authorisedOperators[msg.sender] || msg.sender == owner(),
            "AIArenaINFT: not authorised operator"
        );
        _;
    }

    modifier tokenExists(uint256 tokenId) {
        require(_ownerOf(tokenId) != address(0), "AIArenaINFT: token does not exist");
        _;
    }

    modifier onlyTokenOwner(uint256 tokenId) {
        require(ownerOf(tokenId) == msg.sender, "AIArenaINFT: caller is not token owner");
        _;
    }

    // ── Constructor ────────────────────────────────────────────────────────────

    constructor(address _oracle) ERC721("AI Arena Agent", "ARENA") Ownable(msg.sender) {
        oracle = _oracle;
        emit OracleUpdated(address(0), _oracle);
    }

    // ── Minting ────────────────────────────────────────────────────────────────

    /**
     * @notice Mint a new INFT for an AI agent.
     *
     * The tokenUri should point to a JSON file on 0G Storage containing:
     * {
     *   "name": "...",
     *   "description": "...",
     *   "image": "0g://<rootHash>",          // avatar stored on 0G Storage
     *   "animation_url": "0g://<rootHash>",  // optional battle highlight reel
     *   "attributes": [{ "trait_type": "...", "value": "..." }],
     *   "memory_root": "0x...",              // 0G Storage memory root hash
     *   "model_root": "0x...",               // 0G Storage model root hash
     *   "genesis_root": "0x..."              // Immutable genesis record hash
     * }
     *
     * @param to                   Recipient (agent owner's wallet)
     * @param agentId              Platform UUID for the agent
     * @param clan                 Clan affiliation (solana | base | 0g)
     * @param archetype            Combat archetype
     * @param traits               Initial trait scores
     * @param encryptedMetadataHash Keccak256 of encrypted metadata blob in 0G Storage
     * @param sealedKey            AES-256-GCM key sealed for `to` using ECIES
     * @param genesisRootHash      0G Storage root hash of the genesis record
     * @param tokenUri             0G Storage URI pointing to public metadata JSON
     */
    function mintAgent(
        address to,
        string  calldata agentId,
        string  calldata clan,
        string  calldata archetype,
        AgentTraits calldata traits,
        bytes32 encryptedMetadataHash,
        bytes   calldata sealedKey,
        string  calldata genesisRootHash,
        string  calldata tokenUri
    ) external onlyOperator returns (uint256) {
        require(totalSupply() < MAX_SUPPLY,           "AIArenaINFT: max supply reached");
        require(agentIdToTokenId[agentId] == 0,       "AIArenaINFT: agent already minted");
        require(bytes(agentId).length > 0,            "AIArenaINFT: empty agentId");

        _tokenIdCounter.increment();
        uint256 tokenId = _tokenIdCounter.current();

        _safeMint(to, tokenId);
        _setTokenURI(tokenId, tokenUri);

        agentMetadata[tokenId] = AgentMetadata({
            agentId:              agentId,
            clan:                 clan,
            archetype:            archetype,
            evolutionStage:       1,
            wins:                 0,
            losses:               0,
            draws:                0,
            totalBattles:         0,
            memoryRootHash:       bytes32(0),
            modelRootHash:        "",
            genesisRootHash:      genesisRootHash,
            encryptedMetadataHash: encryptedMetadataHash,
            sealedKey:            sealedKey,
            mintedAt:             block.timestamp,
            lastEvolvedAt:        0,
            lastBattleAt:         0,
            lastTrainingAt:       0,
            traits:               traits
        });

        agentIdToTokenId[agentId] = tokenId;
        emit AgentMinted(tokenId, agentId, to, clan);
        return tokenId;
    }

    // ── ERC-7857: Transfer with re-encrypted metadata ─────────────────────────

    /**
     * @notice ERC-7857 transfer — ownership change + encrypted metadata handover.
     *
     * Flow:
     *   1. Owner requests transfer from oracle
     *   2. Oracle TEE: decrypts metadata → re-encrypts with `to`'s pub key → generates proof
     *   3. Owner calls transfer() with oracle-provided sealedKey + proof
     *   4. Contract verifies proof, updates sealedKey, transfers ERC-721 ownership
     *
     * @param from      Must be current owner
     * @param to        New owner
     * @param tokenId   Token to transfer
     * @param sealedKey New AES key sealed for `to`
     * @param proof     Oracle attestation (EIP-191 personal_sign of keccak256(from,to,tokenId,sealedKey))
     */
    function transfer(
        address from,
        address to,
        uint256 tokenId,
        bytes calldata sealedKey,
        bytes calldata proof
    ) external override tokenExists(tokenId) {
        require(ownerOf(tokenId) == from,  "AIArenaINFT: from is not owner");
        require(
            msg.sender == from ||
            isApprovedForAll(from, msg.sender) ||
            getApproved(tokenId) == msg.sender,
            "AIArenaINFT: not approved"
        );

        // Verify oracle proof
        bytes32 msgHash = keccak256(abi.encodePacked(from, to, tokenId, sealedKey));
        require(_verifyOracleProof(msgHash, proof), "AIArenaINFT: invalid oracle proof");

        // Update sealed key for new owner
        agentMetadata[tokenId].sealedKey = sealedKey;

        // Execute ERC-721 transfer
        _transfer(from, to, tokenId);

        emit MetadataUpdated(tokenId, agentMetadata[tokenId].encryptedMetadataHash);
    }

    // ── ERC-7857: Clone ───────────────────────────────────────────────────────

    /**
     * @notice ERC-7857 clone — create a copy of the agent NFT with identical metadata.
     *         Original owner retains their token. Clone starts at evolution stage 1.
     *         Use case: AI-as-a-Service, delegate without losing original.
     *
     * @param to        Recipient of the clone
     * @param tokenId   Token to clone (must be owned by msg.sender)
     * @param sealedKey AES key sealed for `to`
     * @param proof     Oracle proof authorising the clone
     */
    function clone(
        address to,
        uint256 tokenId,
        bytes calldata sealedKey,
        bytes calldata proof
    ) external override tokenExists(tokenId) onlyTokenOwner(tokenId) returns (uint256) {
        require(cloneCount[tokenId] < MAX_CLONES, "AIArenaINFT: max clones reached");

        bytes32 msgHash = keccak256(abi.encodePacked("clone", msg.sender, to, tokenId, sealedKey));
        require(_verifyOracleProof(msgHash, proof), "AIArenaINFT: invalid oracle proof");

        _tokenIdCounter.increment();
        uint256 cloneId = _tokenIdCounter.current();

        _safeMint(to, cloneId);

        AgentMetadata storage parent = agentMetadata[tokenId];
        agentMetadata[cloneId] = AgentMetadata({
            agentId:               string(abi.encodePacked(parent.agentId, "-clone-", _uint2str(cloneId))),
            clan:                  parent.clan,
            archetype:             parent.archetype,
            evolutionStage:        1,    // Clone starts fresh
            wins:                  0,
            losses:                0,
            draws:                 0,
            totalBattles:          0,
            memoryRootHash:        parent.memoryRootHash,   // Inherits parent memory at clone time
            modelRootHash:         parent.modelRootHash,    // Inherits parent model
            genesisRootHash:       parent.genesisRootHash,
            encryptedMetadataHash: parent.encryptedMetadataHash,
            sealedKey:             sealedKey,               // Sealed for new owner `to`
            mintedAt:              block.timestamp,
            lastEvolvedAt:         0,
            lastBattleAt:          0,
            lastTrainingAt:        0,
            traits:                parent.traits
        });

        cloneParent[cloneId] = tokenId;
        cloneCount[tokenId]++;

        emit AgentCloned(tokenId, cloneId, to);
        return cloneId;
    }

    // ── ERC-7857: Authorize Usage ─────────────────────────────────────────────

    /**
     * @notice ERC-7857 authorizeUsage — grant executor rights without ownership transfer.
     *         Example: rent agent to a tournament contract for 24 hours.
     *
     * @param tokenId     Token whose agent is being licensed
     * @param executor    Address being granted usage (e.g. tournament contract)
     * @param permissions ABI-encoded: (uint256 expiresAt, bytes32 scopeHash)
     */
    function authorizeUsage(
        uint256 tokenId,
        address executor,
        bytes calldata permissions
    ) external override tokenExists(tokenId) onlyTokenOwner(tokenId) {
        (uint256 expiresAt, bytes32 scopeHash) = abi.decode(permissions, (uint256, bytes32));

        usagePermissions[tokenId][executor] = UsagePermissions({
            executor:  executor,
            expiresAt: expiresAt,
            scopeHash: scopeHash,
            active:    true
        });

        emit UsageAuthorized(tokenId, executor, permissions);
    }

    /**
     * @notice Revoke usage permissions for an executor.
     */
    function revokeUsage(uint256 tokenId, address executor)
        external tokenExists(tokenId) onlyTokenOwner(tokenId)
    {
        usagePermissions[tokenId][executor].active = false;
        emit UsageRevoked(tokenId, executor);
    }

    /**
     * @notice Check if an executor has valid usage permission.
     */
    function hasValidUsage(uint256 tokenId, address executor) external view returns (bool) {
        UsagePermissions memory perm = usagePermissions[tokenId][executor];
        if (!perm.active) return false;
        if (perm.expiresAt != 0 && block.timestamp > perm.expiresAt) return false;
        return true;
    }

    // ── Dynamic Metadata Updates (called by platform services) ────────────────

    /**
     * @notice Evolve agent to next stage. Updates traits and token URI.
     *         Evolution stages: 1=Genesis → 2=Recruit → 3=Veteran → 4=Elite → 5=Legend
     */
    function evolveAgent(
        uint256 tokenId,
        AgentTraits calldata newTraits,
        string calldata newTokenUri
    ) external onlyOperator tokenExists(tokenId) {
        AgentMetadata storage meta = agentMetadata[tokenId];
        require(meta.evolutionStage < 5, "AIArenaINFT: already at Legend stage");

        uint8 from = meta.evolutionStage;
        meta.evolutionStage++;
        meta.traits = newTraits;
        meta.lastEvolvedAt = block.timestamp;
        _setTokenURI(tokenId, newTokenUri);

        emit AgentEvolved(tokenId, from, meta.evolutionStage);
        emit TraitsUpdated(tokenId);
    }

    /**
     * @notice Record a battle result and update win/loss counters.
     */
    function recordBattleResult(
        uint256 tokenId,
        bool won,
        bool draw
    ) external onlyOperator tokenExists(tokenId) {
        AgentMetadata storage meta = agentMetadata[tokenId];
        meta.totalBattles++;
        meta.lastBattleAt = block.timestamp;
        if (draw)      meta.draws++;
        else if (won)  meta.wins++;
        else           meta.losses++;

        emit BattleResultRecorded(tokenId, won, meta.totalBattles);
    }

    /**
     * @notice Anchor agent memory Merkle root hash on-chain.
     *         Called after memory compaction / episodic memory update.
     *         rootHash is the 0G Storage Merkle root of the memory tree.
     */
    function updateMemoryRoot(
        uint256 tokenId,
        bytes32 memoryRoot
    ) external onlyOperator tokenExists(tokenId) {
        agentMetadata[tokenId].memoryRootHash = memoryRoot;
        emit MemoryRootUpdated(tokenId, memoryRoot);
    }

    /**
     * @notice Update the active model version (0G Storage root hash of LoRA adapter).
     *         Called after each successful training run.
     */
    function updateModelVersion(
        uint256 tokenId,
        string calldata modelRootHash,
        bytes32 newEncryptedMetadataHash
    ) external onlyOperator tokenExists(tokenId) {
        agentMetadata[tokenId].modelRootHash = modelRootHash;
        agentMetadata[tokenId].encryptedMetadataHash = newEncryptedMetadataHash;
        agentMetadata[tokenId].lastTrainingAt = block.timestamp;
        emit ModelVersionUpdated(tokenId, modelRootHash);
        emit MetadataUpdated(tokenId, newEncryptedMetadataHash);
    }

    /**
     * @notice Update the encrypted metadata hash (called after any metadata change).
     */
    function updateEncryptedMetadata(
        uint256 tokenId,
        bytes32 newEncryptedMetadataHash
    ) external onlyOperator tokenExists(tokenId) {
        agentMetadata[tokenId].encryptedMetadataHash = newEncryptedMetadataHash;
        emit MetadataUpdated(tokenId, newEncryptedMetadataHash);
    }

    // ── Oracle Management ─────────────────────────────────────────────────────

    function setOracle(address newOracle) external onlyOwner {
        address old = oracle;
        oracle = newOracle;
        emit OracleUpdated(old, newOracle);
    }

    // ── Operator Management ───────────────────────────────────────────────────

    function setOperator(address operator, bool authorised) external onlyOwner {
        authorisedOperators[operator] = authorised;
    }

    // ── View Functions ────────────────────────────────────────────────────────

    function getAgentByAgentId(string calldata agentId)
        external view returns (AgentMetadata memory, uint256 tokenId)
    {
        tokenId = agentIdToTokenId[agentId];
        require(tokenId != 0, "AIArenaINFT: agent not found");
        return (agentMetadata[tokenId], tokenId);
    }

    function getTraits(uint256 tokenId)
        external view tokenExists(tokenId) returns (AgentTraits memory)
    {
        return agentMetadata[tokenId].traits;
    }

    function getEvolutionStage(uint256 tokenId)
        external view tokenExists(tokenId) returns (uint8)
    {
        return agentMetadata[tokenId].evolutionStage;
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /**
     * @dev Verify an EIP-191 personal_sign oracle proof.
     *      Proof = oracle's signature of msgHash.
     */
    function _verifyOracleProof(bytes32 msgHash, bytes calldata proof)
        internal view returns (bool)
    {
        bytes32 ethSignedHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", msgHash)
        );
        address recovered = _recoverSigner(ethSignedHash, proof);
        return recovered == oracle;
    }

    function _recoverSigner(bytes32 hash, bytes calldata sig)
        internal pure returns (address)
    {
        require(sig.length == 65, "AIArenaINFT: invalid signature length");
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        return ecrecover(hash, v, r, s);
    }

    function _uint2str(uint256 n) internal pure returns (string memory) {
        if (n == 0) return "0";
        uint256 temp = n; uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buf = new bytes(digits);
        while (n != 0) { digits--; buf[digits] = bytes1(uint8(48 + n % 10)); n /= 10; }
        return string(buf);
    }

    // ── ERC-721 overrides ─────────────────────────────────────────────────────

    function tokenURI(uint256 tokenId)
        public view override(ERC721, ERC721URIStorage) returns (string memory)
    {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public view override(ERC721, ERC721URIStorage, ERC721Enumerable) returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    function _update(address to, uint256 tokenId, address auth)
        internal override(ERC721, ERC721Enumerable) returns (address)
    {
        return super._update(to, tokenId, auth);
    }

    function _increaseBalance(address account, uint128 value)
        internal override(ERC721, ERC721Enumerable)
    {
        super._increaseBalance(account, value);
    }
}
