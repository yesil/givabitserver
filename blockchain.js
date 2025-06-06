const ethers = require('ethers');

// --- Environment Variables ---
// Ensure these are set in your environment (e.g., .env file)
const PRIVATE_KEY = process.env.SERVER_WALLET_PRIVATE_KEY;
const RPC_URL = process.env.AVALANCHE_RPC_URL || 'https://138.68.175.242.sslip.io/ext/bc/mvVnPTEvCKjGqEvZaAXseWSiLtZ9uc3MgiQzkLzGQtBDebxGY/rpc'; // Fuji testnet default
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

// --- Contract ABI (Application Binary Interface) ---
// You need to replace this with the actual ABI of your GatedLinkAccessManager.sol contract
const CONTRACT_ABI = [
  // Constructor
  "constructor(address _erc20TokenAddress)",

  // Functions
  "function checkAccess(bytes32 _linkId, address _user) view returns (bool)",
  "function createLink(bytes32 _linkId, address _creator, uint256 _priceInERC20, bool _initialIsActive)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function gatedLinkInfo(bytes32) view returns (bytes32 linkId, address creator, uint256 priceInERC20, bool isActive)",
  "function getDomainSeparator() view returns (bytes32)",
  "function getLinkDetails(bytes32 _linkId) view returns (tuple(bytes32 linkId, address creator, uint256 priceInERC20, bool isActive))",
  "function getNonce(address _address) view returns (uint256)",
  "function hasAccess(bytes32, address) view returns (bool)",
  "function nonces(address) view returns (uint256)",
  "function owner() view returns (address)",
  "function payForAccess(bytes32 _linkId, address _beneficiary)",
  "function payForAccessWithSignature(bytes32 _linkId, address _beneficiary, address _payer, uint256 _deadline, bytes _signature)",
  "function setLinkActivity(bytes32 _linkId, bool _isActive)",
  "function transferOwnership(address newOwner)",
  "function yourERC20Token() view returns (address)",

  // Events
  "event AccessGranted(bytes32 indexed linkId, address indexed beneficiary)",
  "event EIP712DomainChanged()",
  "event LinkActivitySet(bytes32 indexed linkId, bool isActive)",
  "event LinkCreated(bytes32 indexed linkId, address indexed creator, uint256 priceInERC20, bool isActive)",
  "event MetaTransactionExecuted(bytes32 indexed linkId, address indexed payer, address indexed beneficiary, address relayer)",
  "event PaymentMade(bytes32 indexed linkId, address indexed buyer, address indexed creator, uint256 amountPaid)",

  // Errors
  "error ECDSAInvalidSignature()",
  "error ECDSAInvalidSignatureLength(uint256 length)",
  "error ECDSAInvalidSignatureS(bytes32 s)",
  "error InvalidShortString()",
  "error StringTooLong(string str)"
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

console.log(contract.interface.functions);

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

/**
 * Relays a pre-signed payForAccess transaction to the blockchain.
 * The server's wallet pays the gas for this meta-transaction.
 * @param {string} linkId The keccak256 hash of the URL (bytes32).
 * @param {string} beneficiaryAddress The address of the beneficiary.
 * @param {string} payerAddress The address of the EOA that signed the transaction.
 * @param {string | number} deadline The deadline for the signature.
 * @param {string} signature The EOA's signature.
 * @returns {Promise<ethers.providers.TransactionReceipt>} The transaction receipt.
 * @throws {Error} If blockchain interaction fails or setup is incomplete.
 */
async function relayPayForAccessWithSignature(linkId, beneficiaryAddress, payerAddress, deadline, signature) {
  if (!contract || !wallet) {
    throw new Error('Blockchain interaction module is not properly initialized. Check private key and contract address.');
  }
  try {
    console.log(`Attempting to relay payForAccessWithSignature for linkId: ${linkId}, beneficiary: ${beneficiaryAddress}, payer: ${payerAddress}, deadline: ${deadline}`);
    const tx = await contract.payForAccessWithSignature(linkId, beneficiaryAddress, payerAddress, deadline, signature);
    console.log('Transaction sent via relayer (payForAccessWithSignature):', tx.hash);
    const receipt = await tx.wait(); // Wait for the transaction to be mined
    console.log('Transaction confirmed via relayer (payForAccessWithSignature):', receipt.transactionHash);
    return receipt;
  } catch (error) {
    console.error('Error in relayPayForAccessWithSignature:', error);
    throw new Error(`Failed to relay payForAccessWithSignature on blockchain: ${error.message}`);
  }
}

module.exports = {
  createLinkOnChain,
  setLinkActivityOnChain,
  relayPayForAccessWithSignature,
  // You can export the provider, wallet, or contract instance if needed elsewhere,
  // but it's generally better to keep interactions encapsulated within this module.
}; 