# GivaBit Server - Product Requirements Document

## 1. Overview

The GivaBit Server manages content monetization through the `GatedLinkAccessManager.sol` smart contract on the Avalanche C-Chain. It allows users to register URLs, which are then gated behind a crypto payment, and facilitates sharing these links on social media.

## 2. Core Functionality: Link Creation and Sharing (Req1)

### 2.1. Endpoint: `POST /create-gated-link`

*   **Description:** Accepts a URL from a user, processes it to create a gated link via a smart contract interaction, stores the details, and returns social media shareable content.
*   **Request Body:**
    ```json
    {
      "url": "https://example.com/my-exclusive-content",
      "priceInERC20": "100000000000000000", // Price in the smallest unit of the configured ERC20 token
      "creatorAddress": "0x..." // Address of the content creator who will receive payments
    }
    ```
*   **Actions:**
    1.  **Generate Link ID:** Calculate the `linkId` (e.g., `keccak256(request.url)`). This `linkId` must be a `bytes32` value compatible with the `GatedLinkAccessManager.sol` smart contract.
    2.  **Smart Contract Interaction:**
        *   The server (acting as the contract `owner`) will initiate a `createLink` transaction on the `GatedLinkAccessManager.sol` smart contract deployed on the Avalanche C-Chain.
        *   The transaction will use a locally stored private key corresponding to the contract owner's address.
        *   Parameters for `createLink`:
            *   `_linkId`: The hash generated in step 1.
            *   `_creator`: The `creatorAddress` from the request body. This is the address that will receive the payment.
            *   `_priceInERC20`: The `priceInERC20` from the request body.
            *   `_initialIsActive`: Set to `true` by default.
    3.  **Database Storage:**
        *   Upon successful confirmation of the smart contract transaction:
            *   Store the original `url` and the generated `linkId` (hash) in an SQLite database.
            *   Generate two unique short codes: `buy_short_code` and `access_short_code`.
            *   Update the `GatedLinks` table with both short codes for the new entry.
            *   The SQLite database should be designed as a service accessible for other potential future requirements (e.g., managing users, content metadata).
            *   **Schema for `GatedLinks` table:**
                *   `id` (INTEGER, Primary Key, Autoincrement)
                *   `original_url` (TEXT, NOT NULL)
                *   `link_hash` (TEXT, NOT NULL, UNIQUE) - This is the `linkId`.
                *   `buy_short_code` (TEXT, NOT NULL, UNIQUE) - A short, unique identifier for the buy/purchase link.
                *   `access_short_code` (TEXT, NOT NULL, UNIQUE) - A short, unique identifier for the direct content access link (post-payment).
                *   `creator_address` (TEXT, NOT NULL)
                *   `price_in_erc20` (TEXT, NOT NULL)
                *   `tx_hash` (TEXT, NULLABLE) - Transaction hash of the `createLink` call.
                *   `is_active` (BOOLEAN, NOT NULL, Default TRUE) - Reflects the link's status on the smart contract.
                *   `created_at` (TIMESTAMP, Default CURRENT_TIMESTAMP)
    4.  **Generate Social Media Posts:**
        *   Construct a shareable link in the format: `https://givabit-server-krlus.ondigitalocean.app/content/{link_hash}` (where `{link_hash}` is the `linkId`).
*   **Response Body (Success 201 - Created):**
    ```json
    {
      "linkId": "0x...your_link_hash...",
      "buyShortCode": "your_buy_short_code",
      "accessShortCode": "your_access_short_code",
      "originalUrl": "https://example.com/my-exclusive-content",
      "creatorAddress": "0x...",
      "priceInERC20": "100000000000000000",
      "transactionHash": "0x...tx_hash_from_blockchain...",
      "shareableBuyLink": "https://givabit-server-krlus.ondigitalocean.app/buy/your_buy_short_code"
    }
    ```
*   **Error Handling:**
    *   Return appropriate errors if the URL is invalid, smart contract interaction fails, or database storage fails.

### 2.2. Endpoint: `GET /content/{access_short_code}`

*   **Description:** Redirects a user to the original content URL *after payment is verified*. This link is intended for use once access is granted.
    *   **Initial Implementation:** Directly retrieve the `original_url` from the SQLite database using the `access_short_code` and perform an HTTP 302 redirect.
    *   **Future Enhancement:** Before redirecting, this endpoint will need to verify if the user has paid for access. This would involve:
        1.  Looking up the `link_hash` associated with the `access_short_code` from the database.
        2.  Checking access using `GatedLinkAccessManager.checkAccess(link_hash, user_address)`.
*   **Path Parameters:**
    *   `access_short_code` (string): The short, unique identifier for direct content access.
*   **Actions (Initial):**
    1.  Retrieve the `ContentLinks` record from the SQLite database where `access_short_code` matches the path parameter.
    2.  If found, and `is_active` is true, issue an HTTP 302 Redirect to the `original_url`.
    3.  If found but `is_active` is false, return 403 Forbidden (or similar, indicating inactive link).
    4.  If not found, return an HTTP 404 Not Found.
*   **Response (Success 302):** HTTP Redirect to the `original_url`.
*   **Response (Error 404):**
    ```json
    {
      "error": "Content not found"
    }
    ```

### 2.3. Endpoint: `GET /generate`
*   **Description:** Retrieves social media shareable posts for a given gated link.
*   **Query Parameters:**
    *   `linkHash` (string, required): The hash (`linkId`) of the content link.
    *   `walletAddress` (string, required): The wallet address of the user/creator requesting the posts. (Purpose: context, potential future customization, or ownership verification).
*   **Actions:**
    1.  Verify `linkHash` and `walletAddress` parameters are provided.
    2.  Query the database to find the `ContentLinks` record matching `linkHash`. If not found, return 404.
    3.  Retrieve the `buy_short_code` from the found record.
    4.  Construct the `shareableLink` (this is a buy link): `https://givabit-server-krlus.ondigitalocean.app/buy/{buy_short_code_from_db}`.
    5.  Prepare social media post suggestions using the constructed `shareableLink`:
        *   **X (Twitter):** "Check out my new content! Purchase access here: [shareable_link] #GivaBit #ContentMonetization"
        *   **Instagram Post Caption / Story Link Sticker Text:** "New exclusive content! Get access: [shareable_link] #GivaBit #ExclusiveContent"
        *   (Consider allowing users to request posts for specific platforms, e.g., `?platforms=twitter,instagram`)
*   **Response Body (Success 200):**
    ```json
    {
      "linkId": "0x...input_link_hash...",
      "buyShortCode": "retrieved_buy_short_code",
      "shareableBuyLink": "https://givabit-server-krlus.ondigitalocean.app/buy/retrieved_buy_short_code",
      "socialPosts": {
        "twitter": "Check out my new content! Purchase access here: https://givabit-server-krlus.ondigitalocean.app/buy/retrieved_buy_short_code #GivaBit #ContentMonetization",
        "instagram": "New exclusive content! Get access: https://givabit-server-krlus.ondigitalocean.app/buy/retrieved_buy_short_code #GivaBit #ExclusiveContent"
      }
    }
    ```
*   **Response Body (Error 400 - Bad Request):** If required parameters are missing.
*   **Response Body (Error 404 - Not Found):** If `linkHash` does not exist (especially if database lookup is performed).

### 2.4. Endpoint: `PATCH /links/{link_hash}/status`
*   **Description:** Updates the active status of a gated link (e.g., to archive it by setting it inactive). This action is performed by the server as the owner of the smart contract.
*   **Path Parameters:**
    *   `link_hash` (string, required): The hash (`linkId`) of the content link to update.
*   **Request Body:**
    ```json
    {
      "isActive": false 
    }
    ```
    *   Note: To reactivate, send `"isActive": true`.
*   **Actions:**
    1.  Validate the `link_hash` and the request body.
    2.  Verify the link exists in the database (optional but recommended).
    3.  **Smart Contract Interaction:**
        *   The server (acting as the contract `owner`) will call the `setLinkActivity(_linkId, newActiveState)` function on the `GatedLinkAccessManager.sol` smart contract.
            *   `_linkId`: The `link_hash` from the path parameter.
            *   `newActiveState`: The boolean value from the `isActive` field in the request body.
    4.  **Database Update:**
        *   Upon successful confirmation of the smart contract transaction, update the `is_active` field in the SQLite `GatedLinks` table for the corresponding `link_hash` to reflect the `newActiveState`.
        *   Store the transaction hash of the `setLinkActivity` call (e.g., in a new `status_update_tx_hash` column or an audit log if detailed history is needed).
*   **Response Body (Success 200 - OK):**
    ```json
    {
      "linkId": "0x...link_hash...",
      "isActive": false, // or true, reflecting the new state
      "message": "Link status updated successfully.",
      "transactionHash": "0x...tx_hash_from_setLinkActivity..."
    }
    ```
*   **Error Handling:**
    *   Return 400 if the request body is invalid.
    *   Return 404 if the `link_hash` is not found in the database.
    *   Return 500 or appropriate error if smart contract interaction fails.

### 2.5. Endpoint: `GET /buy/{buy_short_code}`
*   **Description:** Serves as the landing page for a "buy link". It provides information necessary for a user to initiate a payment for accessing the gated content. This endpoint is what users will typically click from a shared social media post.
*   **Path Parameters:**
    *   `buy_short_code` (string, required): The short, unique identifier for the buy/purchase link.
*   **Actions:**
    1.  Validate the `buy_short_code` parameter.
    2.  Query the `GatedLinks` table in the database using the `buy_short_code` to retrieve the full link details, including `link_hash`, `creator_address`, `price_in_erc20`, `original_url` (for metadata like title/description if not stored separately), and `is_active` status.
    3.  If the link is not found in the database or `is_active` is false, return an appropriate error (e.g., 404 Not Found or 403 Forbidden if inactive).
    4.  **Smart Contract Interaction (Recommended for accuracy):**
        *   Call `GatedLinkAccessManager.getLinkDetails(link_hash_from_db)` to fetch the most current `priceInERC20`, `creator` address, and `isActive` status from the blockchain. This ensures the user sees the correct price and status, even if the DB is slightly out of sync.
        *   The `erc20TokenAddress` used for payment should also be retrieved (it's immutable in the contract, so can be fetched once or configured).
    5.  Prepare the response. This could be JSON data for a client app or an HTML page.
*   **Response Body (Success 200 - JSON example):**
    ```json
    {
      "linkId": "0x...link_hash_from_db...",
      "buyShortCode": "input_buy_short_code",
      // It's good to fetch title/description from a dedicated metadata store or ContentLinks table if available
      // "title": "Example Content Title", 
      // "description": "Brief overview of the premium content.",
      "creatorAddress": "0x...creator_address_from_contract_or_db...",
      "priceInERC20": "current_price_from_contract",
      "erc20TokenAddress": "0x...address_of_payment_token...",
      "isActiveOnContract": true, // Current status from smart contract
      "paymentContractAddress": "CONTRACT_ADDRESS_OF_GatedLinkAccessManager"
    }
    ```
*   **Response (HTML alternative):** Could render a simple page displaying content title, price, creator, and a button/QR code to initiate payment (e.g., deep-linking to the GivaBit mobile app with payment parameters).
*   **Error Handling:**
    *   Return 404 if `buy_short_code` is not found.
    *   Return 403 or similar if the link is found but marked inactive (either in DB or on-chain).
    *   Return 500 for server-side errors (DB query failure, smart contract interaction issues).

### 2.6. Endpoint: `GET /links/creator/{creatorAddress}`
*   **Description:** Retrieves a list of gated links created by a specific `creatorAddress`, sorted by creation date in descending order (newest first).
*   **Path Parameters:**
    *   `creatorAddress` (string, required): The wallet address of the content creator.
*   **Query Parameters (Optional for Pagination):**
    *   `limit` (integer, optional, default: 20): Number of items to return per page.
    *   `offset` (integer, optional, default: 0): Number of items to skip for pagination.
*   **Actions:**
    1.  Validate the `creatorAddress` path parameter (e.g., basic address format check).
    2.  Validate optional `limit` and `offset` query parameters (must be non-negative integers).
    3.  Query the `GatedLinks` table in the SQLite database:
        *   Select records where `creator_address` matches the provided `creatorAddress`.
        *   Order the results by `created_at DESC` (descending order).
        *   Apply `LIMIT` and `OFFSET` clauses based on the validated query parameters.
    4.  Construct an array of link objects from the query results. Each object should include fields like `linkId` (link_hash), `buyShortCode`, `accessShortCode`, `originalUrl`, `priceInERC20`, `isActive`, and `createdAt`.
    5.  (Optional) Perform an additional count query to get the `totalMatches` for the given `creatorAddress` to help with client-side pagination UI.
*   **Response Body (Success 200):**
    ```json
    {
      "links": [
        {
          "linkId": "0x...hash_of_newest_link...",
          "buyShortCode": "new_buy_code",
          "accessShortCode": "new_access_code",
          "originalUrl": "https://example.com/newest-content", // Or a title/preview if stored
          "priceInERC20": "100000000000000000",
          "isActive": true,
          "createdAt": "YYYY-MM-DDTHH:MM:SS.sssZ"
        },
        {
          "linkId": "0x...hash_of_older_link...",
          "buyShortCode": "old_buy_code",
          "accessShortCode": "old_access_code",
          "originalUrl": "https://example.com/older-content",
          "priceInERC20": "50000000000000000",
          "isActive": false,
          "createdAt": "YYYY-MM-DDTHH:MM:SS.sssZ"
        }
      ],
      "pagination": {
        "limit": 20, // The actual limit used
        "offset": 0, // The actual offset used
        "totalMatches": 50 // Total number of links matching the creatorAddress before pagination
      }
    }
    ```
*   **Error Handling:**
    *   Return 400 if `creatorAddress` is invalid or if pagination parameters are malformed (e.g., negative values).
    *   Return 500 for internal server errors (e.g., database query failure).

## 3. System Components

### 3.1. SQLite Database
*   **Purpose:** Store mappings between original content URLs and their corresponding blockchain `linkId` (hash), creator information, and price.
*   **Accessibility:** Must be set up as a service that can be accessed by various parts of the application, potentially supporting concurrent connections if the server is multi-threaded/multi-process.
*   **Deployment:** The SQLite database file will reside on the server.

### 3.2. Avalanche C-Chain Interaction Module
*   **Purpose:** Handles all communication with the `GatedLinkAccessManager.sol` smart contract.
*   **Key Management:** Securely stores and uses the private key of the server's wallet, which is the `owner` of the smart contract. This key is necessary for signing transactions like `createLink`.
*   **Functionality:**
    *   Formatting and sending transactions (e.g., `createLink`).
    *   Querying contract state (e.g., `getLinkDetails`, `checkAccess` - for future use).

## 4. Security Considerations

*   **Private Key Management:** The server's private key for interacting with the Avalanche C-Chain must be stored securely (e.g., environment variable, secrets manager) and never exposed.
*   **Input Validation:** Validate all inputs, especially the URL, to prevent malicious inputs or errors.
*   **Smart Contract Interaction:** Ensure all parameters sent to the smart contract are correctly formatted.

## 5. Future Considerations

*   **Meta-transactions:** For gasless experiences for creators (e.g., server pays gas for `createLink`) or consumers (if `payForAccess` is modified to support it).
*   **Batch Operations:** For creating or updating multiple links.
*   **Advanced Analytics:** More detailed tracking of link performance.
*   **Webhook Subscriptions:** Allow external services to subscribe to events (e.g., new content created).
