const ethers = require('ethers');

// --- Environment Variables ---
// Ensure these are set in your environment (e.g., .env file)
const PRIVATE_KEY = process.env.SERVER_WALLET_PRIVATE_KEY;
const RPC_URL = process.env.AVALANCHE_RPC_URL || 'https://138.68.175.242.sslip.io/ext/bc/mvVnPTEvCKjGqEvZaAXseWSiLtZ9uc3MgiQzkLzGQtBDebxGY/rpc'; // Fuji testnet default
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

// --- Contract ABI (Application Binary Interface) ---
// You need to replace this with the actual ABI of your GatedLinkAccessManager.sol contract
const CONTRACT_ABI = [
  // Functions
  "function createLink(bytes32 _linkId, address _creator, uint256 _priceInERC20, bool _initialIsActive) external",
  "function setLinkActivity(bytes32 _linkId, bool _isActive) external",
  "function payForAccess(bytes32 _linkId) external",
  "function checkAccess(bytes32 _linkId, address _user) external view returns (bool)",
  "function getLinkDetails(bytes32 _linkId) external view returns (tuple(bytes32 linkId, address creator, uint256 priceInERC20, bool isActive) link)",
  "function transferOwnership(address newOwner) external",
  "function owner() external view returns (address)",
  "function yourERC20Token() external view returns (address)",

  // Events
  "event LinkCreated(bytes32 indexed linkId, address indexed creator, uint256 priceInERC20, bool isActive)",
  "event LinkActivitySet(bytes32 indexed linkId, bool isActive)",
  "event PaymentMade(bytes32 indexed linkId, address indexed buyer, address indexed creator, uint256 amountPaid)",
  "event AccessGranted(bytes32 indexed linkId, address indexed buyer)"
];

if (!PRIVATE_KEY || !CONTRACT_ADDRESS) {
  console.error("Missing critical environment variables: SERVER_WALLET_PRIVATE_KEY or CONTRACT_ADDRESS");
  // In a real app, you might want to prevent the server from starting or throw a more specific error.
  // For now, functions will likely fail if these are not set.
}

// --- Ethers.js Setup ---
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = PRIVATE_KEY ? new ethers.Wallet(PRIVATE_KEY, provider) : null; // Only create wallet if private key is available
const contract = CONTRACT_ADDRESS && CONTRACT_ABI.length > 2 && wallet ? new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet) : null;

/**
 * Creates a new gated link on the blockchain.
 * @param {string} linkId The keccak256 hash of the URL (bytes32).
 * @param {string} creatorAddress The address of the content creator.
 * @param {string} priceInERC20 The price in the smallest unit of the ERC20 token.
 * @param {boolean} initialIsActive Whether the link is active by default.
 * @returns {Promise<ethers.providers.TransactionReceipt>} The transaction receipt.
 * @throws {Error} If blockchain interaction fails or setup is incomplete.
 */
async function createLinkOnChain(linkId, creatorAddress, priceInERC20, initialIsActive) {
  console.log(contract, wallet);
  if (!contract || !wallet) {
    throw new Error('Blockchain interaction module is not properly initialized. Check private key and contract address.');
  }
  try {
    console.log(`Attempting to create link on chain: ${linkId} by ${creatorAddress} for price ${priceInERC20}`);
    const tx = await contract.createLink(linkId, creatorAddress, priceInERC20, initialIsActive);
    console.log('Transaction sent:', tx.hash);
    const receipt = await tx.wait(); // Wait for the transaction to be mined
    console.log('Transaction confirmed:', receipt.transactionHash);
    return receipt;
  } catch (error) {
    console.error('Error in createLinkOnChain:', error);
    throw new Error(`Failed to create link on blockchain: ${error.message}`);
  }
}

/**
 * Sets the active status of a link on the blockchain.
 * @param {string} linkId The keccak256 hash of the URL (bytes32).
 * @param {boolean} newActiveState The new active state (true or false).
 * @returns {Promise<ethers.providers.TransactionReceipt>} The transaction receipt.
 * @throws {Error} If blockchain interaction fails or setup is incomplete.
 */
async function setLinkActivityOnChain(linkId, newActiveState) {
  if (!contract || !wallet) {
    throw new Error('Blockchain interaction module is not properly initialized. Check private key and contract address.');
  }
  try {
    console.log(`Attempting to set link activity for ${linkId} to ${newActiveState}`);
    const tx = await contract.setLinkActivity(linkId, newActiveState);
    console.log('Transaction sent:', tx.hash);
    const receipt = await tx.wait(); // Wait for the transaction to be mined
    console.log('Transaction confirmed:', receipt.transactionHash);
    return receipt;
  } catch (error) {
    console.error('Error in setLinkActivityOnChain:', error);
    throw new Error(`Failed to set link activity on blockchain: ${error.message}`);
  }
}

module.exports = {
  createLinkOnChain,
  setLinkActivityOnChain,
  // You can export the provider, wallet, or contract instance if needed elsewhere,
  // but it's generally better to keep interactions encapsulated within this module.
}; 