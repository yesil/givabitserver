const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, 'givabit.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Error opening database', err.message);
    throw err;
  } else {
    console.log('Connected to the SQLite database.');
    initializeDb();
  }
});

function initializeDb() {
  const createTableSql = `
    CREATE TABLE IF NOT EXISTS GatedLinks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_url TEXT NOT NULL,
      link_hash TEXT NOT NULL UNIQUE,      -- This is the linkId from the smart contract
      buy_short_code TEXT NOT NULL UNIQUE, -- For the link that initiates purchase
      access_short_code TEXT NOT NULL UNIQUE, -- For direct content access post-payment
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

  db.serialize(() => {
    db.run(createTableSql, (err) => {
      if (err) {
        console.error('Error creating GatedLinks table', err.message);
      } else {
        console.log('GatedLinks table checked/created successfully.');
        // Create the trigger after table creation
        db.run(createTriggerSql, (triggerErr) => {
          if (triggerErr) {
            console.error('Error creating GatedLinks updated_at trigger', triggerErr.message);
          }
        });
      }
    });
  });
}

/**
 * Stores a new gated link in the database.
 * @param {object} linkData
 * @param {string} linkData.original_url
 * @param {string} linkData.link_hash
 * @param {string} linkData.buy_short_code
 * @param {string} linkData.access_short_code
 * @param {string} linkData.creator_address
 * @param {string} linkData.price_in_erc20
 * @param {string} linkData.tx_hash
 * @param {boolean} linkData.is_active
 * @returns {Promise<number>} The ID of the newly inserted row.
 */
function storeGatedLink(linkData) {
  return new Promise((resolve, reject) => {
    const sql = `INSERT INTO GatedLinks (original_url, link_hash, buy_short_code, access_short_code, creator_address, price_in_erc20, tx_hash, is_active)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    const params = [
      linkData.original_url,
      linkData.link_hash,
      linkData.buy_short_code,
      linkData.access_short_code,
      linkData.creator_address,
      linkData.price_in_erc20,
      linkData.tx_hash,
      linkData.is_active === undefined ? true : linkData.is_active,
    ];
    db.run(sql, params, function (err) {
      if (err) {
        console.error('Error storing gated link:', err.message);
        reject(err);
      } else {
        resolve(this.lastID);
      }
    });
  });
}

/**
 * Retrieves a link by its access_short_code.
 * @param {string} accessShortCode
 * @returns {Promise<object|null>} The link data or null if not found.
 */
function getLinkByAccessShortCode(accessShortCode) {
  return new Promise((resolve, reject) => {
    const sql = `SELECT * FROM GatedLinks WHERE access_short_code = ?`;
    db.get(sql, [accessShortCode], (err, row) => {
      if (err) {
        console.error('Error fetching link by access_short_code:', err.message);
        reject(err);
      } else {
        resolve(row || null);
      }
    });
  });
}

/**
 * Retrieves a link by its buy_short_code.
 * @param {string} buyShortCode
 * @returns {Promise<object|null>} The link data or null if not found.
 */
function getLinkByBuyShortCode(buyShortCode) {
  return new Promise((resolve, reject) => {
    const sql = `SELECT * FROM GatedLinks WHERE buy_short_code = ?`;
    db.get(sql, [buyShortCode], (err, row) => {
      if (err) {
        console.error('Error fetching link by buy_short_code:', err.message);
        reject(err);
      } else {
        resolve(row || null);
      }
    });
  });
}

/**
 * Retrieves a link by its link_hash (smart contract linkId).
 * @param {string} linkHash
 * @returns {Promise<object|null>} The link data or null if not found.
 */
function getLinkByHash(linkHash) {
  return new Promise((resolve, reject) => {
    const sql = `SELECT * FROM GatedLinks WHERE link_hash = ?`;
    db.get(sql, [linkHash], (err, row) => {
      if (err) {
        console.error('Error fetching link by link_hash:', err.message);
        reject(err);
      } else {
        resolve(row || null);
      }
    });
  });
}

/**
 * Updates the active status and status_update_tx_hash of a link.
 * @param {string} linkHash
 * @param {boolean} isActive
 * @param {string} statusUpdateTxHash
 * @returns {Promise<number>} The number of rows updated.
 */
function updateLinkStatus(linkHash, isActive, statusUpdateTxHash) {
  return new Promise((resolve, reject) => {
    const sql = `UPDATE GatedLinks SET is_active = ?, status_update_tx_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE link_hash = ?`;
    db.run(sql, [isActive, statusUpdateTxHash, linkHash], function (err) {
      if (err) {
        console.error('Error updating link status:', err.message);
        reject(err);
      } else {
        resolve(this.changes);
      }
    });
  });
}

/**
 * Retrieves links for a specific creator with pagination.
 * Also retrieves the total count of links for that creator for pagination metadata.
 * @param {string} creatorAddress The wallet address of the creator.
 * @param {number} limit Max number of links to return.
 * @param {number} offset Number of links to skip.
 * @returns {Promise<{links: Array<object>, totalMatches: number}>} An object containing the list of links and the total count.
 */
async function getLinksByCreator(creatorAddress, limit = 20, offset = 0) {
  return new Promise((resolve, reject) => {
    const linksSql = `
      SELECT id, original_url, link_hash, buy_short_code, access_short_code, creator_address, price_in_erc20, tx_hash, status_update_tx_hash, is_active, created_at, updated_at
      FROM GatedLinks
      WHERE creator_address = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?;
    `;
    const countSql = `SELECT COUNT(*) as totalMatches FROM GatedLinks WHERE creator_address = ?;`;

    db.serialize(() => {
      // First, get the total count
      db.get(countSql, [creatorAddress], (countErr, countRow) => {
        if (countErr) {
          console.error('Error fetching count for getLinksByCreator:', countErr.message);
          return reject(countErr);
        }

        const totalMatches = countRow ? countRow.totalMatches : 0;

        // Then, get the paginated links
        db.all(linksSql, [creatorAddress, limit, offset], (linksErr, rows) => {
          if (linksErr) {
            console.error('Error fetching links for getLinksByCreator:', linksErr.message);
            reject(linksErr);
          } else {
            resolve({ links: rows || [], totalMatches });
          }
        });
      });
    });
  });
}

module.exports = {
  initializeDb, // Exported for potential direct call, though it runs on connect
  storeGatedLink,
  getLinkByAccessShortCode,
  getLinkByBuyShortCode,
  getLinkByHash,
  updateLinkStatus,
  getLinksByCreator
  // dbInstance: db // Optionally export the db instance if needed for complex queries outside this module
}; 