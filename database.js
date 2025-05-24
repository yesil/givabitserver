const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, 'givabit.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Error opening database', err.message);
    throw err;
  } else {
    console.log('Connected to the SQLite database.');
    initializeDb().catch(initErr => {
      console.error('Failed to initialize database:', initErr.message);
    });
  }
});

// Promisified DB helpers
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) {
        console.error('Error running SQL:', err.message, '\nSQL:', sql, '\nParams:', params);
        reject(err);
      } else {
        resolve(this);
      }
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        console.error('Error running SQL GET:', err.message, '\nSQL:', sql, '\nParams:', params);
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        console.error('Error running SQL ALL:', err.message, '\nSQL:', sql, '\nParams:', params);
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

async function initializeDb() {
  const createTableSql = `
    CREATE TABLE IF NOT EXISTS GatedLinks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_url TEXT NOT NULL,
      link_hash TEXT NOT NULL UNIQUE,      -- This is the linkId from the smart contract
      buy_short_code TEXT NOT NULL UNIQUE, -- For the link that initiates purchase
      access_short_code TEXT NOT NULL UNIQUE, -- For direct content access post-payment
      title TEXT,                          -- Title for the link
      creator_address TEXT NOT NULL,
      price_in_erc20 TEXT NOT NULL,
      tx_hash TEXT,                       -- Transaction hash of the createLink call
      status_update_tx_hash TEXT,         -- Transaction hash of the last setLinkActivity call
      is_active BOOLEAN NOT NULL DEFAULT TRUE, -- Reflects the link's status on the smart contract
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  // Trigger for updated_at
  const createTriggerSql = `
    CREATE TRIGGER IF NOT EXISTS set_timestamp_gatedlinks
    AFTER UPDATE ON GatedLinks
    FOR EACH ROW
    BEGIN
      UPDATE GatedLinks SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
    END;
  `;

  try {
    await dbRun(createTableSql);
    console.log('GatedLinks table checked/created successfully.');
    await dbRun(createTriggerSql);
    console.log('GatedLinks updated_at trigger checked/created successfully.');
  } catch (err) {
    console.error('Error during DB initialization:', err.message);
    throw err;
  }
}

/**
 * Stores a new gated link in the database.
 * @param {object} linkData
 * @param {string} linkData.original_url
 * @param {string} linkData.link_hash
 * @param {string} linkData.buy_short_code
 * @param {string} linkData.access_short_code
 * @param {string} linkData.title
 * @param {string} linkData.creator_address
 * @param {string} linkData.price_in_erc20
 * @param {string} linkData.tx_hash
 * @param {boolean} linkData.is_active
 * @returns {Promise<number>} The ID of the newly inserted row.
 */
async function storeGatedLink(linkData) {
  const sql = `INSERT INTO GatedLinks (original_url, link_hash, buy_short_code, access_short_code, title, creator_address, price_in_erc20, tx_hash, is_active)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const params = [
    linkData.original_url,
    linkData.link_hash,
    linkData.buy_short_code,
    linkData.access_short_code,
    linkData.title,
    linkData.creator_address ? linkData.creator_address.toLowerCase() : null,
    linkData.price_in_erc20,
    linkData.tx_hash,
    linkData.is_active === undefined ? true : linkData.is_active,
  ];
  try {
    const result = await dbRun(sql, params);
    return result.lastID;
  } catch (err) {
    console.error('Error storing gated link:', err.message);
    throw err;
  }
}

/**
 * Retrieves a link by its access_short_code.
 * @param {string} accessShortCode
 * @returns {Promise<object|null>} The link data or null if not found.
 */
async function getLinkByAccessShortCode(accessShortCode) {
  const sql = `SELECT * FROM GatedLinks WHERE access_short_code = ?`;
  try {
    const row = await dbGet(sql, [accessShortCode]);
    return row || null;
  } catch (err) {
    console.error('Error fetching link by access_short_code:', err.message);
    throw err;
  }
}

/**
 * Retrieves a link by its buy_short_code.
 * @param {string} buyShortCode
 * @returns {Promise<object|null>} The link data or null if not found.
 */
async function getLinkByBuyShortCode(buyShortCode) {
  const sql = `SELECT * FROM GatedLinks WHERE buy_short_code = ?`;
  try {
    const row = await dbGet(sql, [buyShortCode]);
    return row || null;
  } catch (err) {
    console.error('Error fetching link by buy_short_code:', err.message);
    throw err;
  }
}

/**
 * Retrieves a link by its link_hash (smart contract linkId).
 * @param {string} linkHash
 * @returns {Promise<object|null>} The link data or null if not found.
 */
async function getLinkByHash(linkHash) {
  const sql = `SELECT * FROM GatedLinks WHERE link_hash = ?`;
  try {
    const row = await dbGet(sql, [linkHash]);
    return row || null;
  } catch (err) {
    console.error('Error fetching link by link_hash:', err.message);
    throw err;
  }
}

/**
 * Updates the active status and status_update_tx_hash of a link.
 * @param {string} linkHash
 * @param {boolean} isActive
 * @param {string} statusUpdateTxHash
 * @returns {Promise<number>} The number of rows updated.
 */
async function updateLinkStatus(linkHash, isActive, statusUpdateTxHash) {
  const sql = `UPDATE GatedLinks SET is_active = ?, status_update_tx_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE link_hash = ?`;
  try {
    const result = await dbRun(sql, [isActive, statusUpdateTxHash, linkHash]);
    return result.changes;
  } catch (err) {
    console.error('Error updating link status:', err.message);
    throw err;
  }
}

/**
 * Retrieves links for a specific creator.
 * @param {string} creatorAddress The wallet address of the creator.
 * @returns {Promise<Array<object>>} A promise that resolves to an array of link objects.
 */
async function getLinksByCreator(creatorAddress) {
  const normalizedCreatorAddress = creatorAddress ? creatorAddress.toLowerCase() : null;
  const linksSql = `
    SELECT id, original_url, link_hash, buy_short_code, access_short_code, title, creator_address, price_in_erc20, tx_hash, status_update_tx_hash, is_active, created_at, updated_at
    FROM GatedLinks
    WHERE creator_address = ?
    ORDER BY created_at DESC;
  `;

  try {
    const links = await dbAll(linksSql, [normalizedCreatorAddress]);
    return links || []; // Return an empty array if no links are found
  } catch (err) {
    // Error already logged by dbAll helper
    console.error('Error fetching links for getLinksByCreator:', err.message); // Added for specific context
    throw err;
  }
}

module.exports = {
  initializeDb,
  storeGatedLink,
  getLinkByAccessShortCode,
  getLinkByBuyShortCode,
  getLinkByHash,
  updateLinkStatus,
  getLinksByCreator
}; 