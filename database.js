const { Pool } = require('pg');
const path = require('path'); // path might not be needed for DB_PATH anymore

// PostgreSQL connection configuration
// It's highly recommended to use environment variables for these settings
const pool = new Pool({
  user: process.env.PGUSER || 'your_pg_user', // Replace with your PG user or env var
  host: process.env.PGHOST || 'localhost',    // Replace with your PG host or env var
  database: process.env.PGDATABASE || 'givabit_db', // Replace with your PG database name or env var
  password: process.env.PGPASSWORD || 'your_pg_password', // Replace with your PG password or env var
  port: parseInt(process.env.PGPORT) || 5432,          // Replace with your PG port or env var, ensure it's an integer
  ssl: { rejectUnauthorized: true }, // Corrected SSL configuration to be an object
});

pool.on('connect', () => {
  console.log('Connected to the PostgreSQL database.');
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client. Stack:', err.stack);
  process.exit(-1); // Exit if we can't connect/stay connected to DB
});

// Initialize DB (check connection and create table if not exists)
async function initializeDb() {
  let client; // Declare client outside try to check it in catch/finally
  try {
    client = await pool.connect();
    // PostgreSQL uses SERIAL for auto-incrementing primary keys
    // TEXT for strings, VARCHAR for limited strings, TIMESTAMPTZ for timezone-aware timestamps
    // UNIQUE constraint for link_hash, buy_short_code, access_short_code
    // Default value for is_active
    // created_at and updated_at with default CURRENT_TIMESTAMP
    const createTableSql = `
      CREATE TABLE IF NOT EXISTS GatedLinks (
        id SERIAL PRIMARY KEY,
        original_url TEXT NOT NULL,
        link_hash TEXT NOT NULL UNIQUE,
        buy_short_code TEXT NOT NULL UNIQUE,
        access_short_code TEXT NOT NULL UNIQUE,
        title TEXT,
        creator_address TEXT NOT NULL,
        price_in_erc20 TEXT NOT NULL,
        tx_hash TEXT,
        status_update_tx_hash TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `;

    // Trigger for updated_at on PostgreSQL
    // We need a function and then a trigger
    const createFunctionSql = `
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
         NEW.updated_at = CURRENT_TIMESTAMP;
         RETURN NEW;
      END;
      $$ language 'plpgsql';
    `;

    const createTriggerSql = `
      DROP TRIGGER IF EXISTS set_timestamp_gatedlinks ON GatedLinks; -- Drop if exists to avoid error
      CREATE TRIGGER set_timestamp_gatedlinks
      BEFORE UPDATE ON GatedLinks
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
    `;

    await client.query(createTableSql);
    console.log('GatedLinks table checked/created successfully.');
    await client.query(createFunctionSql);
    console.log('update_updated_at_column function checked/created successfully.');
    await client.query(createTriggerSql);
    console.log('GatedLinks updated_at trigger checked/created successfully.');

  } catch (err) {
    console.error('Error during DB initialization. Message:', err.message, 'Stack:', err.stack);
    if (!client) {
        console.error('DB Initialization Error Insight: Failed to acquire client from pool. This strongly suggests a connection or configuration issue (credentials, host, port, SSL, firewall/trusted sources, or DB not ready).');
    }
    throw err; // Re-throw the original error
  } finally {
    if (client) { // Check if client was successfully acquired before releasing
      client.release();
    }
  }
}

// Call initializeDb when the module is loaded
initializeDb().catch(initErr => {
  console.error('Failed to initialize database on load:', initErr.message);
  // Depending on the severity, you might want to process.exit() here if DB is critical
});


/**
 * Stores a new gated link in the database.
 * @param {object} linkData
 * @returns {Promise<number>} The ID of the newly inserted row.
 */
async function storeGatedLink(linkData) {
  // In PostgreSQL, query parameters are $1, $2, etc.
  // The RETURNING id clause gets the id of the inserted row.
  const sql = `INSERT INTO GatedLinks (original_url, link_hash, buy_short_code, access_short_code, title, creator_address, price_in_erc20, tx_hash, is_active)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               RETURNING id`;
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
    const result = await pool.query(sql, params);
    return result.rows[0].id; // PostgreSQL returns the id in rows[0].id
  } catch (err) {
    console.error('Error storing gated link. Message:', err.message, 'SQL:', sql, 'Params:', params, 'Stack:', err.stack);
    throw err;
  }
}

/**
 * Retrieves a link by its access_short_code.
 * @param {string} accessShortCode
 * @returns {Promise<object|null>} The link data or null if not found.
 */
async function getLinkByAccessShortCode(accessShortCode) {
  const sql = `SELECT * FROM GatedLinks WHERE access_short_code = $1`;
  try {
    const result = await pool.query(sql, [accessShortCode]);
    return result.rows[0] || null; // result.rows is an array, take the first element or null
  } catch (err) {
    console.error('Error fetching link by access_short_code. Message:', err.message, 'SQL:', sql, 'Params:', [accessShortCode], 'Stack:', err.stack);
    throw err;
  }
}

/**
 * Retrieves a link by its buy_short_code.
 * @param {string} buyShortCode
 * @returns {Promise<object|null>} The link data or null if not found.
 */
async function getLinkByBuyShortCode(buyShortCode) {
  const sql = `SELECT * FROM GatedLinks WHERE buy_short_code = $1`;
  try {
    const result = await pool.query(sql, [buyShortCode]);
    return result.rows[0] || null;
  } catch (err) {
    console.error('Error fetching link by buy_short_code. Message:', err.message, 'SQL:', sql, 'Params:', [buyShortCode], 'Stack:', err.stack);
    throw err;
  }
}

/**
 * Retrieves a link by its link_hash (smart contract linkId).
 * @param {string} linkHash
 * @returns {Promise<object|null>} The link data or null if not found.
 */
async function getLinkByHash(linkHash) {
  const sql = `SELECT * FROM GatedLinks WHERE link_hash = $1`;
  try {
    const result = await pool.query(sql, [linkHash]);
    return result.rows[0] || null;
  } catch (err) {
    console.error('Error fetching link by link_hash. Message:', err.message, 'SQL:', sql, 'Params:', [linkHash], 'Stack:', err.stack);
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
  // The status_update_tx_hash is set, and updated_at will be handled by the trigger
  const sql = `UPDATE GatedLinks SET is_active = $1, status_update_tx_hash = $2 WHERE link_hash = $3`;
  try {
    const result = await pool.query(sql, [isActive, statusUpdateTxHash, linkHash]);
    return result.rowCount; // rowCount gives the number of affected rows in pg
  } catch (err) {
    console.error('Error updating link status. Message:', err.message, 'SQL:', sql, 'Params:', [isActive, statusUpdateTxHash, linkHash], 'Stack:', err.stack);
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
    WHERE creator_address = $1
    ORDER BY created_at DESC;
  `;

  try {
    const result = await pool.query(linksSql, [normalizedCreatorAddress]);
    return result.rows || []; // result.rows is the array of rows
  } catch (err) {
    console.error('Error fetching links for getLinksByCreator. Message:', err.message, 'SQL:', linksSql, 'Params:', [normalizedCreatorAddress], 'Stack:', err.stack);
    throw err;
  }
}

module.exports = {
  // initializeDb, // Not typically exported directly, called on module load
  storeGatedLink,
  getLinkByAccessShortCode,
  getLinkByBuyShortCode,
  getLinkByHash,
  updateLinkStatus,
  getLinksByCreator,
  // Export pool if direct access is needed elsewhere, though usually not recommended
  // pool 
}; 