const { Pool } = require('pg');
const fs = require('fs').promises; // For reading migration files
const path = require('path');

// PostgreSQL connection configuration
// It's highly recommended to use environment variables for these settings
const pool = new Pool({
  user: process.env.PGUSER || 'your_pg_user', // Replace with your PG user or env var
  host: process.env.PGHOST || 'localhost',    // Replace with your PG host or env var
  database: process.env.PGDATABASE || 'givabit_db', // Replace with your PG database name or env var
  password: process.env.PGPASSWORD || 'your_pg_password', // Replace with your PG password or env var
  port: parseInt(process.env.PGPORT) || 5432,          // Replace with your PG port or env var, ensure it's an integer
  ssl: { rejectUnauthorized: false }, // Allow self-signed certificates (less secure)
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
  let client;
  try {
    client = await pool.connect();

    // 1. Ensure GatedLinks table exists (basic structure)
    const createGatedLinksTableSql = `
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
    await client.query(createGatedLinksTableSql);
    console.log('GatedLinks table schema base checked/created successfully.');

    // 2. Ensure schema_version table exists
    const createSchemaVersionTableSql = `
      CREATE TABLE IF NOT EXISTS schema_version (
        id INT PRIMARY KEY DEFAULT 1, -- Only one row
        version INT NOT NULL DEFAULT 0
      );
    `;
    await client.query(createSchemaVersionTableSql);
    console.log('schema_version table checked/created successfully.');

    // Insert initial version if table was just created and is empty
    const ensureInitialVersionSql = `
      INSERT INTO schema_version (id, version) VALUES (1, 0)
      ON CONFLICT (id) DO NOTHING;
    `;
    await client.query(ensureInitialVersionSql);

    // 3. Get current schema version
    const { rows: versionRows } = await client.query('SELECT version FROM schema_version WHERE id = 1;');
    let currentVersion = 0;
    if (versionRows.length > 0) {
      currentVersion = versionRows[0].version;
    }
    console.log(`Current DB schema version: ${currentVersion}`);

    // 4. Read migration files
    const migrationsDir = path.join(__dirname, 'migrations');
    let migrationFiles = [];
    try {
      migrationFiles = await fs.readdir(migrationsDir);
      migrationFiles = migrationFiles
        .filter(file => file.endsWith('.sql'))
        .sort((a, b) => parseInt(a.split('_')[0]) - parseInt(b.split('_')[0])); // Sort by numeric prefix
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log('No migrations directory found, skipping migrations.');
      } else {
        throw err; // Re-throw other errors
      }
    }
    

    // 5. Apply pending migrations
    for (const file of migrationFiles) {
      const fileVersion = parseInt(file.split('_')[0]);
      if (fileVersion > currentVersion) {
        console.log(`Applying migration: ${file}...`);
        const filePath = path.join(migrationsDir, file);
        const sqlScript = await fs.readFile(filePath, 'utf-8');
        
        // Execute the migration script (can contain multiple statements)
        // For simplicity, assuming scripts don't need complex transaction management here.
        // For production, you might want BEGIN; ... COMMIT/ROLLBACK per file.
        await client.query(sqlScript); 
        
        // Update schema version in DB
        await client.query('UPDATE schema_version SET version = $1 WHERE id = 1;', [fileVersion]);
        console.log(`Migration ${file} applied. DB schema version updated to ${fileVersion}.`);
        currentVersion = fileVersion; // Update in-memory currentVersion
      } else {
        console.log(`Migration ${file} (version ${fileVersion}) already applied or is older, skipping.`);
      }
    }

    if (migrationFiles.length === 0) {
        console.log('No migration files found in migrations directory.');
    }

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
  const sql = `INSERT INTO GatedLinks (
                 original_url, link_hash, buy_short_code, access_short_code, title, 
                 creator_address, price_in_erc20, tx_hash, is_active,
                 description, author_name, author_profile_picture_url, content_vignette_url, publication_date, extracted_metadata, ai_social_posts
               )
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
    linkData.description,
    linkData.author_name,
    linkData.author_profile_picture_url,
    linkData.content_vignette_url,
    linkData.publication_date,
    linkData.extracted_metadata ? JSON.stringify(linkData.extracted_metadata) : null, // Ensure metadata is stringified if it's an object
    null // Initialize ai_social_posts as null
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
    SELECT 
      id, original_url, link_hash, buy_short_code, access_short_code, title, 
      creator_address, price_in_erc20, tx_hash, status_update_tx_hash, is_active, 
      description, author_name, author_profile_picture_url, content_vignette_url, publication_date, extracted_metadata, ai_social_posts,
      created_at, updated_at
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

async function replaceGatedLinkByHash(linkData) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); // Start transaction

    const deleteSql = `DELETE FROM GatedLinks WHERE link_hash = $1`;
    await client.query(deleteSql, [linkData.link_hash]);

    // All columns from the table definition, excluding id (auto-generated) and updated_at (trigger-handled)
    const insertSql = `INSERT INTO GatedLinks (
                         original_url, link_hash, buy_short_code, access_short_code, title, 
                         creator_address, price_in_erc20, tx_hash, status_update_tx_hash, is_active,
                         description, author_name, author_profile_picture_url, content_vignette_url, 
                         publication_date, extracted_metadata, created_at, ai_social_posts
                       )
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
                       RETURNING id`;
    const params = [
      linkData.original_url,
      linkData.link_hash,
      linkData.buy_short_code,
      linkData.access_short_code,
      linkData.title,
      linkData.creator_address ? linkData.creator_address.toLowerCase() : null,
      linkData.price_in_erc20,
      linkData.tx_hash, // Preserving original creation tx_hash
      linkData.status_update_tx_hash, // Preserving status update tx_hash
      linkData.is_active === undefined ? true : linkData.is_active,
      linkData.description,
      linkData.author_name,
      linkData.author_profile_picture_url,
      linkData.content_vignette_url,
      linkData.publication_date,
      linkData.extracted_metadata ? JSON.stringify(linkData.extracted_metadata) : null,
      linkData.created_at ? new Date(linkData.created_at) : new Date(), // Preserve original created_at, or use current time if somehow missing
      linkData.ai_social_posts ? JSON.stringify(linkData.ai_social_posts) : null // Preserve ai_social_posts
    ];
    
    const result = await client.query(insertSql, params);
    await client.query('COMMIT'); // Commit transaction
    return result.rows[0].id;
  } catch (err) {
    await client.query('ROLLBACK'); // Rollback transaction on error
    console.error('Error replacing gated link. Message:', err.message, 'SQL (delete):', deleteSql, 'SQL (insert):', insertSql, 'Params:', params, 'Stack:', err.stack);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Updates the ai_social_posts for a link by its buy_short_code.
 * @param {string} buyShortCode
 * @param {object} aiSocialPosts - The JSON object containing social media posts.
 * @returns {Promise<object|null>} The updated link data or null if not found/updated.
 */
async function updateAISocialPosts(buyShortCode, aiSocialPosts) {
  // updated_at will be handled by the trigger
  const sql = `UPDATE GatedLinks SET ai_social_posts = $1 WHERE buy_short_code = $2 RETURNING *`;
  try {
    const result = await pool.query(sql, [aiSocialPosts ? JSON.stringify(aiSocialPosts) : null, buyShortCode]);
    if (result.rowCount === 0) {
      console.warn(`No link found with buy_short_code '${buyShortCode}' to update AI social posts.`);
      return null;
    }
    console.log(`AI social posts updated for buy_short_code: ${buyShortCode}`);
    return result.rows[0]; // Return the updated row
  } catch (err) {
    console.error('Error updating AI social posts. Message:', err.message, 'SQL:', sql, 'Params:', [aiSocialPosts, buyShortCode], 'Stack:', err.stack);
    throw err;
  }
}

/**
 * Retrieves the latest active links for a feed, sorted by creation date.
 * @param {number} limit - Maximum number of links to return (default: 20)
 * @param {number} offset - Number of links to skip for pagination (default: 0)
 * @param {string} walletAddress - The wallet address of the user (for future customization)
 * @returns {Promise<Array<object>>} A promise that resolves to an array of link objects.
 */
async function getLatestLinksForFeed(limit = 20, offset = 0, walletAddress = null) {
  // For now, we return all active links sorted by creation date
  // In the future, this can be customized based on walletAddress (e.g., following, preferences, etc.)
  const sql = `
    SELECT 
      id, original_url, link_hash, buy_short_code, access_short_code, title, 
      creator_address, price_in_erc20, tx_hash, status_update_tx_hash, is_active, 
      description, author_name, author_profile_picture_url, content_vignette_url, 
      publication_date, extracted_metadata, ai_social_posts,
      created_at, updated_at
    FROM GatedLinks
    WHERE is_active = true
    ORDER BY created_at DESC
    LIMIT $1 OFFSET $2;
  `;

  try {
    const result = await pool.query(sql, [limit, offset]);
    return result.rows || [];
  } catch (err) {
    console.error('Error fetching links for feed. Message:', err.message, 'SQL:', sql, 'Params:', [limit, offset], 'Stack:', err.stack);
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
  replaceGatedLinkByHash, // Export the new function
  updateAISocialPosts,
  getLatestLinksForFeed, // Export the new feed function
  // Export pool if direct access is needed elsewhere, though usually not recommended
  // pool
}; 