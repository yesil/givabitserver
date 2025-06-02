require("dotenv").config(); // Load environment variables from .env file

const express = require("express");
const crypto = require("crypto"); // Used for generating mock transaction hashes
const ethers = require("ethers");
const { nanoid } = require("nanoid");
const path = require("path"); // Ensure path module is required
const playwright = require("playwright");
const { google } = require("googleapis");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Database interactions
const db = require("./database");

// Blockchain interactions
const { createLinkOnChain, setLinkActivityOnChain } = require("./blockchain");

const app = express();
const port = process.env.PORT || 3000;

// Serve apple-app-site-association with correct content type
app.get("/.well-known/apple-app-site-association", (req, res) => {
  res.type("application/json");
  res.sendFile(path.join(__dirname, "public", "apple-app-site-association"));
});

// Serve apple-app-site-association at root for flexibility (some CDNs/proxies might not serve .well-known correctly)
app.get("/apple-app-site-association", (req, res) => {
  res.type("application/json");
  res.sendFile(path.join(__dirname, "public", "apple-app-site-association"));
});

app.use(express.json()); // Middleware to parse JSON request bodies
app.use(express.static("public")); // Serve static files from 'public' directory

const GIVABIT_BASE_URL =
  process.env.GIVABIT_APP_URL ||
  "https://givabit-server-krlus.ondigitalocean.app";
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

const youtube = google.youtube({
  version: "v3",
  auth: YOUTUBE_API_KEY,
});

/**
 * Generates a keccak256 hash for a given string (URL).
 * @param {string} data The string to hash.
 * @returns {string} The hex string of the hash, prefixed with 0x.
 */
function generateLinkHash(data) {
  // Ensure the data is UTF-8 encoded bytes before hashing
  const dataBytes = ethers.toUtf8Bytes(data);
  return ethers.keccak256(dataBytes);
}

/**
 * Generates a short unique code using nanoid.
 * @returns {string} A short unique identifier.
 */
function generateShortCode() {
  return nanoid(7); // Generates a 7-character short ID, e.g., 'abc123X'
}

// --- API Endpoints ---

// req1: POST /create-gated-link
app.post("/create-gated-link", async (req, res) => {
  const {
    url,
    title,
    priceInERC20,
    creatorAddress,
    // New optional metadata fields from request body
    description,
    authorName, // This is how client might send it, matching create-link-intent output
    authorProfilePictureUrl,
    contentVignetteUrl,
    publicationDate,
  } = req.body;

  if (!url || !priceInERC20 || !creatorAddress) {
    // Title, description, authorName etc. are optional at the point of link creation
    return res.status(400).json({
      error: "Missing required fields: url, priceInERC20, creatorAddress",
    });
  }

  try {
    const linkHash = generateLinkHash(url);
    const buyShortCode = generateShortCode();
    const accessShortCode = generateShortCode();

    // 1. Smart Contract Interaction
    let actualTxHash =
      "0xmockTransactionHash_default_" + crypto.randomBytes(10).toString("hex");
    try {
      const txReceipt = await createLinkOnChain(
        linkHash,
        creatorAddress,
        priceInERC20,
        true
      );
      actualTxHash = txReceipt.transactionHash;
      console.log("Blockchain transaction successful:", actualTxHash);
    } catch (blockchainError) {
      console.error("Blockchain interaction failed:", blockchainError.message);
      return res.status(500).json({
        error: "Smart contract interaction failed",
        details: blockchainError.message,
      });
    }

    // 2. Database Storage
    try {
      await db.storeGatedLink({
        original_url: url,
        link_hash: linkHash,
        buy_short_code: buyShortCode,
        access_short_code: accessShortCode,
        title: title,
        creator_address: creatorAddress,
        price_in_erc20: priceInERC20,
        tx_hash: actualTxHash,
        is_active: true,
        // Pass through new optional metadata fields
        description: description,
        author_name: authorName, // Map authorName from req to author_name for DB
        author_profile_picture_url: authorProfilePictureUrl,
        content_vignette_url: contentVignetteUrl,
        publication_date: publicationDate ? new Date(publicationDate) : null,
      });
    } catch (dbError) {
      console.error("Database storage failed:", dbError.message);
      return res.status(500).json({
        error: "Failed to store link details in database",
        details: dbError.message,
      });
    }

    const shareableBuyLink = `${GIVABIT_BASE_URL}/buy/${buyShortCode}`;

    res.status(201).json({
      linkId: linkHash,
      buyShortCode: buyShortCode,
      accessShortCode: accessShortCode,
      originalUrl: url,
      title: title,
      creatorAddress: creatorAddress,
      priceInERC20: priceInERC20,
      transactionHash: actualTxHash,
      shareableBuyLink: shareableBuyLink,
      // Return new optional metadata fields in response
      description: description,
      authorName: authorName,
      authorProfilePictureUrl: authorProfilePictureUrl,
      contentVignetteUrl: contentVignetteUrl,
      publicationDate: publicationDate
        ? new Date(publicationDate).toISOString()
        : null,
    });
  } catch (error) {
    console.error("Error creating gated link:", error);
    res
      .status(500)
      .json({ error: "Failed to create gated link", details: error.message });
  }
});

// req1: GET /content/:access_short_code
app.get("/content/:access_short_code", async (req, res) => {
  const { access_short_code } = req.params;
  try {
    // Database Query
    const link = await db.getLinkByAccessShortCode(access_short_code);
    // const mockLink = { original_url: 'https://example.com/mock-redirect-target' } // Placeholder

    if (link && link.original_url) {
      // Future: Add access check via smart contract here
      // For now, also check if link is active in DB
      if (!link.is_active) {
        return res
          .status(403)
          .json({ error: "This link is currently inactive." });
      }
      res.redirect(302, link.original_url);
    } else {
      res.status(404).json({ error: "Content not found" });
    }
  } catch (error) {
    console.error(
      `Error fetching content for access_short_code ${access_short_code}:`,
      error
    );
    res
      .status(500)
      .json({ error: "Failed to retrieve content", details: error.message });
  }
});

// New endpoint for buy/purchase landing (primarily for mobile app)
app.get("/buy/:buy_short_code", async (req, res) => {
  const { buy_short_code } = req.params;

  try {
    const link = await db.getLinkByBuyShortCode(buy_short_code);

    if (!link) {
      return res.status(404).json({ error: "Purchase link not found." });
    }

    if (!link.is_active) {
      return res.status(403).json({
        error: "This link is currently inactive and cannot be purchased.",
      });
    }

    // In a full implementation, you might also fetch live details from the smart contract here
    // const contractDetails = await blockchain.getLinkDetailsFromChain(link.link_hash);
    // const currentPrice = contractDetails.priceInERC20;
    // const isActiveOnChain = contractDetails.isActive;
    // const erc20TokenAddress = await blockchain.getErc20TokenAddress(); // If needed

    // For now, use data primarily from DB, assuming it's reasonably in sync or SC calls are too slow for this EP
    res.status(200).json({
      linkId: link.link_hash, // Full hash for the app to use with payForAccess
      buyShortCode: link.buy_short_code,
      title: link.title, // Add title here
      // description: link.description,
      creatorAddress: link.creator_address,
      priceInERC20: link.price_in_erc20, // This should ideally be from SC for accuracy
      // erc20TokenAddress: erc20TokenAddress, // The token for payment
      paymentContractAddress: process.env.CONTRACT_ADDRESS, // The GatedLinkAccessManager contract address
      isActiveOnDb: link.is_active, // Status from DB
      // isActiveOnChain: isActiveOnChain // Add if fetching from SC
    });
  } catch (error) {
    console.error(
      `Error fetching buy link details for ${buy_short_code}:`,
      error
    );
    res.status(500).json({
      error: "Failed to retrieve purchase link details",
      details: error.message,
    });
  }
});

// PATCH /links/{link_hash}/status
app.patch("/links/:link_hash/status", async (req, res) => {
  const { link_hash } = req.params;
  const { isActive } = req.body;

  if (typeof isActive !== "boolean") {
    return res
      .status(400)
      .json({ error: "Invalid request body: isActive (boolean) is required." });
  }

  try {
    // Verify link exists (optional but good practice)
    const linkExists = await db.getLinkByHash(link_hash);
    if (!linkExists) {
      return res
        .status(404)
        .json({ error: "Link not found with the provided hash." });
    }

    // 1. Smart Contract Interaction
    let actualUpdateTxHash =
      "0xmockUpdateTxHash_default_" + crypto.randomBytes(10).toString("hex"); // Default mock
    try {
      const txReceipt = await setLinkActivityOnChain(link_hash, isActive);
      actualUpdateTxHash = txReceipt.transactionHash;
      console.log("Blockchain status update successful:", actualUpdateTxHash);
    } catch (blockchainError) {
      console.error(
        "Blockchain interaction for status update failed:",
        blockchainError.message
      );
      return res.status(500).json({
        error: "Smart contract interaction failed for status update",
        details: blockchainError.message,
      });
    }

    // 2. Database Update
    try {
      await db.updateLinkStatus(link_hash, isActive, actualUpdateTxHash);
    } catch (dbError) {
      console.error(
        `Database update for link status failed for ${link_hash}:`,
        dbError.message
      );
      // If blockchain call was made, this could lead to inconsistent state.
      return res.status(500).json({
        error: "Failed to update link status in database",
        details: dbError.message,
      });
    }

    res.status(200).json({
      linkId: link_hash,
      isActive: isActive,
      message: "Link status updated successfully.",
      transactionHash: actualUpdateTxHash,
    });
  } catch (error) {
    console.error(`Error updating status for link ${link_hash}:`, error);
    res
      .status(500)
      .json({ error: "Failed to update link status", details: error.message });
  }
});

// Endpoint to get links by creatorAddress
app.get("/links/creator/:creatorAddress", async (req, res) => {
  let { creatorAddress } = req.params; // Use let to allow reassignment

  // Validate creatorAddress format before normalization
  if (
    !creatorAddress ||
    typeof creatorAddress !== "string" ||
    !creatorAddress.startsWith("0x")
  ) {
    return res.status(400).json({ error: "Invalid creatorAddress format." });
  }

  // Normalize to lowercase for consistent querying
  creatorAddress = creatorAddress.toLowerCase();

  try {
    const links = await db.getLinksByCreator(creatorAddress);

    const formattedLinks = links.map((link) => {
      const shareableBuyLink = `${GIVABIT_BASE_URL}/buy/${link.buy_short_code}`;
      const contentAuthorName = link.author_name || null;
      const formattedLink = {
        linkId: link.link_hash,
        buyShortCode: link.buy_short_code,
        accessShortCode: link.access_short_code,
        originalUrl: link.original_url,
        title: link.title,
        priceInERC20: link.price_in_erc20,
        isActive: link.is_active,
        createdAt: link.created_at,
        shareableBuyLink: shareableBuyLink,
        contentVignetteUrl: link.content_vignette_url,
        description: link.description || null,
        authorName: link.author_name || null,
      };
      return formattedLink;
    });

    console.log(
      "Formatted links for creator:",
      creatorAddress,
      JSON.stringify(formattedLinks, null, 2)
    ); // Log the formatted links

    res.status(200).json({
      links: formattedLinks,
    });
  } catch (error) {
    console.error(`Error fetching links for creator ${creatorAddress}:`, error);
    res.status(500).json({
      error: "Failed to retrieve links for creator",
      details: error.message,
    });
  }
});

// --- Helper functions for metadata extraction ---

async function getYoutubeVideoDetails(youtubeUrl) {
  try {
    const videoId = extractYoutubeVideoId(youtubeUrl);
    if (!videoId) {
      throw new Error("Invalid YouTube URL or unable to extract video ID.");
    }

    if (!YOUTUBE_API_KEY) {
      console.warn(
        "YOUTUBE_API_KEY not configured. Cannot fetch YouTube video details."
      );
      return {
        title: "YouTube Video (ID: " + videoId + ")",
        description: "API key not configured to fetch full details.",
      };
    }

    const response = await youtube.videos.list({
      part: "snippet,contentDetails",
      id: videoId,
    });

    if (!response.data.items || response.data.items.length === 0) {
      throw new Error("Video not found or API error.");
    }

    const video = response.data.items[0];
    const snippet = video.snippet;
    // const contentDetails = video.contentDetails; // Contains duration, dimension etc.

    const thumbnails = snippet.thumbnails;
    const thumbnailUrl =
      thumbnails.maxres?.url ||
      thumbnails.high?.url ||
      thumbnails.medium?.url ||
      thumbnails.default?.url;

    return {
      title: snippet.title,
      description: snippet.description,
      author_name: snippet.channelTitle,
      // author_profile_picture_url: null, // YouTube API for videos doesn't directly give channel profile pic. Need separate channels.list call.
      content_vignette_url: thumbnailUrl,
      publication_date: snippet.publishedAt
        ? new Date(snippet.publishedAt)
        : null,
      // extracted_metadata: { duration: contentDetails.duration } // Example
    };
  } catch (error) {
    console.error(
      `Error fetching YouTube video details for ${youtubeUrl}:`,
      error.message
    );
    // Return a generic title if API fails or videoId is bad
    const videoId = extractYoutubeVideoId(youtubeUrl) || "unknown_id";
    return {
      title: `YouTube Video (ID: ${videoId})`,
      description: `Could not fetch details: ${error.message}`,
    };
  }
}

function extractYoutubeVideoId(url) {
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
  const match = url.match(regExp);
  return match && match[2].length === 11 ? match[2] : null;
}

async function getGenericPageMetadata(url) {
  let browser = null;
  try {
    // Launch browser. Chromium is generally well-supported.
    // You might need to install browser binaries if they are not found: npx playwright install
    browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 }); // Wait for network to be idle, timeout after 30s

    const metadata = await page.evaluate(() => {
      const getMetaContent = (name) => {
        const element =
          document.querySelector(`meta[name="${name}"]`) ||
          document.querySelector(`meta[property="${name}"]`);
        return element ? element.content : null;
      };

      let title =
        getMetaContent("og:title") ||
        getMetaContent("twitter:title") ||
        document.title;
      let description =
        getMetaContent("og:description") ||
        getMetaContent("twitter:description") ||
        getMetaContent("description");
      let authorName =
        getMetaContent("author") || getMetaContent("og:site_name"); // or specific author tags if known
      let profilePicUrl =
        getMetaContent("og:image:secure_url") ||
        getMetaContent("og:image") ||
        getMetaContent("twitter:image"); // This is often content image, not author profile
      let contentVignetteUrl = profilePicUrl; // Reuse, or look for specific article image
      let publicationDate =
        getMetaContent("article:published_time") ||
        getMetaContent("og:updated_time");

      // Try to clean up title and description
      if (title) title = title.trim();
      if (description) description = description.trim();
      if (authorName) authorName = authorName.trim();

      // More specific selectors if needed:
      // Example: const h1Title = document.querySelector('h1')?.innerText;
      // if (!title && h1Title) title = h1Title;

      return {
        title: title || "Untitled Page",
        description: description,
        author_name: authorName,
        author_profile_picture_url: null, // Hard to get reliably without specific site knowledge or more complex scraping
        content_vignette_url: contentVignetteUrl,
        publication_date: publicationDate ? new Date(publicationDate) : null,
        // extracted_metadata: {} // For additional fields
      };
    });

    await browser.close();
    return metadata;
  } catch (error) {
    console.error(
      `Playwright - Error fetching generic page metadata for ${url}:`,
      error.message
    );
    if (browser) {
      await browser.close();
    }
    return {
      title: `Web Page at ${url.substring(0, 50)}...`, // Truncate long URLs
      description: `Could not fetch details: ${error.message}`,
    };
  }
}

// --- New Metadata Endpoint ---
app.get("/metadata/:buy_short_code", async (req, res) => {
  const { buy_short_code } = req.params;
  const forceRefresh = req.query.force === "true";

  try {
    const link = await db.getLinkByBuyShortCode(buy_short_code);
    if (!link) {
      return res
        .status(404)
        .json({ error: "Link not found with the provided buy_short_code." });
    }

    // If not forcing refresh and a title already exists in DB, return cached data.
    // link.title being non-null implies metadata has been fetched at least once.
    if (!forceRefresh && link.title !== null) {
      console.log(
        `Returning cached metadata for buy_short_code: ${buy_short_code} (title exists)`
      );
      const responseData = {
        linkId: link.link_hash,
        originalUrl: link.original_url,
        title: link.title,
        description: link.description,
        authorName: link.author_name || null,
        authorProfilePictureUrl: link.author_profile_picture_url,
        contentVignetteUrl: link.content_vignette_url,
        publicationDate: link.publication_date,
        creatorAddress: link.creator_address,
        priceInERC20: link.price_in_erc20,
        isActive: link.is_active,
        buyShortCode: link.buy_short_code,
      };
      return res.status(200).json(responseData);
    }

    // If we reach here, we need to refresh (either forced or title was null).
    let extractedData = {};
    const originalUrl = link.original_url;

    if (extractYoutubeVideoId(originalUrl)) {
      console.log(
        `Refreshing metadata for link associated with buy_short_code: ${buy_short_code} (forceRefresh: ${forceRefresh})`
      ); // Log only for YouTube refresh
      console.log(`Fetching metadata for YouTube URL: ${originalUrl}`);
      extractedData = await getYoutubeVideoDetails(originalUrl);
    } else {
      console.log(
        `Fetching metadata for generic URL (buy_short_code: ${buy_short_code}, forceRefresh: ${forceRefresh}): ${originalUrl}`
      );
      extractedData = await getGenericPageMetadata(originalUrl);
    }

    // Merge with existing link data, prioritizing newly fetched data
    const updatedLinkData = {
      ...link,
      title: extractedData.title || link.title, // Keep original title if new one is null/empty
      description: extractedData.description,
      author_name: extractedData.author_name,
      author_profile_picture_url: extractedData.author_profile_picture_url,
      content_vignette_url: extractedData.content_vignette_url,
      publication_date: extractedData.publication_date,
      extracted_metadata: extractedData.extracted_metadata, // Store any extra bits here
    };

    await db.replaceGatedLinkByHash(updatedLinkData);

    // Prepare response (subset of fields, or all, depending on needs)
    const responseData = {
      linkId: updatedLinkData.link_hash,
      originalUrl: updatedLinkData.original_url,
      title: updatedLinkData.title,
      description: updatedLinkData.description,
      authorName: updatedLinkData.author_name || null,
      authorProfilePictureUrl: updatedLinkData.author_profile_picture_url,
      contentVignetteUrl: updatedLinkData.content_vignette_url,
      publicationDate: updatedLinkData.publication_date,
      creatorAddress: updatedLinkData.creator_address,
      priceInERC20: updatedLinkData.price_in_erc20,
      isActive: updatedLinkData.is_active,
      buyShortCode: updatedLinkData.buy_short_code, // Useful for client
      // extractedMetadata: updatedLinkData.extracted_metadata, // Optionally return this
    };

    res.status(200).json(responseData);
  } catch (error) {
    console.error(`Error in /metadata/${buy_short_code} endpoint:`, error);
    res
      .status(500)
      .json({ error: "Failed to extract metadata", details: error.message });
  }
});

// --- New Link Intent Endpoint (Metadata Extraction Only) ---
app.post("/create-link-intent", async (req, res) => {
  const { url, creatorAddress } = req.body;

  if (!url || !creatorAddress) {
    return res.status(400).json({
      error: "Missing required fields: url, creatorAddress",
    });
  }

  // Basic URL validation (can be enhanced)
  try {
    new URL(url); // Check if URL is valid
  } catch (_) {
    return res.status(400).json({ error: "Invalid URL format." });
  }

  // Basic creatorAddress validation (can be enhanced)
  if (typeof creatorAddress !== "string" || !creatorAddress.startsWith("0x")) {
    return res.status(400).json({ error: "Invalid creatorAddress format." });
  }

  try {
    console.log(
      `Received /create-link-intent for URL: ${url} by ${creatorAddress}`
    );
    let extractedMetadata = {};

    if (extractYoutubeVideoId(url)) {
      console.log(`Fetching metadata for YouTube URL (intent): ${url}`);
      extractedMetadata = await getYoutubeVideoDetails(url);
    } else {
      console.log(`Fetching metadata for generic URL (intent): ${url}`);
      extractedMetadata = await getGenericPageMetadata(url);
    }

    // Ensure essential fields from metadata are at least null if not found
    const responsePayload = {
      originalUrl: url,
      creatorAddress: creatorAddress.toLowerCase(), // Normalize address
      title: extractedMetadata.title || null,
      description: extractedMetadata.description || null,
      authorName: extractedMetadata.author_name || null,
      authorProfilePictureUrl:
        extractedMetadata.author_profile_picture_url || null,
      contentVignetteUrl: extractedMetadata.content_vignette_url || null,
      publicationDate: extractedMetadata.publication_date || null,
      // Include any other specific or raw fields from extracted_metadata directly if needed
      // For example, if extractedMetadata had a field like 'platformSpecificData':
      // platformSpecificData: extractedMetadata.platformSpecificData || null,
      status: "metadata_extracted",
    };

    res.status(200).json(responsePayload);
  } catch (error) {
    console.error(`Error in /create-link-intent for URL ${url}:`, error);
    res.status(500).json({
      error: "Failed to process link intent and extract metadata",
      details: error.message,
    });
  }
});

// --- New Social Post Generation Endpoint ---
app.get("/social/:buy_short_code", async (req, res) => {
  const { buy_short_code } = req.params;
  const forceRefresh = req.query.force === "true";

  try {
    const link = await db.getLinkByBuyShortCode(buy_short_code);
    if (!link) {
      return res
        .status(404)
        .json({ error: "Link not found with the provided buy_short_code." });
    }

    // If not forcing refresh and AI social posts already exist, return them.
    if (!forceRefresh && link.ai_social_posts) {
      console.log(
        `Returning cached AI social posts for buy_short_code: ${buy_short_code}`
      );
      return res.status(200).json({
        linkId: link.link_hash,
        buyShortCode: link.buy_short_code,
        shareableBuyLink: `${GIVABIT_BASE_URL}/buy/${link.buy_short_code}`,
        socialPosts: link.ai_social_posts,
        source: "cache",
      });
    }

    console.log(
      `Generating new AI social posts for buy_short_code: ${buy_short_code} (forceRefresh: ${forceRefresh})`
    );

    const shareableBuyLink = `${GIVABIT_BASE_URL}/buy/${link.buy_short_code}`;
    let generatedPosts = {};

    // --- START ACTUAL AI INTEGRATION ---
    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      console.error("GEMINI_API_KEY is not set. Cannot generate AI posts.");
      return res.status(500).json({ error: "AI service not configured." });
    }

    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const modelName = "gemini-2.5-flash-preview-05-20"; // Updated model name
    const model = genAI.getGenerativeModel({ model: modelName });

    const contentTitle = link.title || "Exclusive Content";
    const contentDescription =
      link.description || "Check out this amazing piece of content!";
    const contentAuthorName = link.author_name || null;

    const platforms = ["X", "Instagram", "Facebook", "Telegram", "Discord"];
    // You can make variationsPerPlatform dynamic, e.g., from a query param or config
    const variationsPerPlatform = parseInt(req.query.variations) || 1; // Default to 1 variation

    try {
      const platformGenerationPromises = platforms.map(async (platform) => {
        // Estimate link length to help AI with character counts for X
        const linkLength = shareableBuyLink.length;
        const twitterMaxChars = 280;

        let specificPlatformInstruction = `Generate ${variationsPerPlatform} catchy social media post(s) for ${platform} to promote the following content with the intent to sell access.`;
        let returnStructureExample = `For example, if ${variationsPerPlatform} is 1, return ["Post 1 text..."] or if ${variationsPerPlatform} is 2, return ["Post 1 text...", "Post 2 text..."]`;

        if (platform === "X") {
          specificPlatformInstruction = `Generate ${variationsPerPlatform} catchy tweet(s) for X (Twitter) to promote the following content with the intent to sell access. Each tweet, *including the buy link* (which is ${linkLength} characters long), must NOT exceed ${twitterMaxChars} characters in total.`;
          if (variationsPerPlatform === 1) {
            returnStructureExample = `This means for X, you must return a JSON array of exactly one string: ["Tweet text (max ${twitterMaxChars} chars total)..."]`;
          } else {
            returnStructureExample = `This means for X, if ${variationsPerPlatform} is 2, you must return a JSON array of exactly two strings: ["Tweet 1 (max ${twitterMaxChars} chars total)...", "Tweet 2 (max ${twitterMaxChars} chars total)..."]`;
          }
        }

        const prompt = `
${specificPlatformInstruction}

The goal is to maximize clicks on the buy link.

Content Title: "${contentTitle}"
Content Description: "${contentDescription}"
Buy Link: ${shareableBuyLink}
${
  contentAuthorName
    ? `Author Name (e.g., Channel, Site): "${contentAuthorName}"`
    : ""
}

General Instructions for all posts:
- Each post should be engaging and create a sense of urgency or exclusivity.
- Include relevant hashtags.
- Ensure the buy link (${shareableBuyLink}) is clearly presented.
- If an Author Name is provided, consider incorporating it naturally if it enhances the post (e.g., "New article from [Author Name]!").
- If generating multiple variations, ensure they are distinct from each other.

Platform-Specific Hints:
${
  platform === "Instagram"
    ? "- For Instagram, suggest relevant emojis and a strong call to action. If the buy link is long, you can say 'Link in bio!' and still include the link directly in the text for copy-pasting ease."
    : ""
}
${
  platform === "X"
    ? `- For X (Twitter), each tweet must be concise, impactful, and strictly adhere to the ${twitterMaxChars} character limit *inclusive of the buy link*. Use strong call-to-actions.`
    : ""
}

Output Format Instructions:
Return the response strictly as a JSON array of strings, where each string is a complete post text.
${returnStructureExample}.
Make sure to properly escape all special characters (like quotes, newlines \\n) within the post strings so that the entire response is a single, valid JSON array.
If you cannot generate posts for any reason, return an empty JSON array [].
Do not use any markdown (like \`\`\`json) in your response; only the raw JSON array.
Make sure to escape special characters in the posts so that JSON parsing works.
`;

        console.log(
          `Generating content for ${platform} with prompt (parallel)...`
        );
        // console.log("Prompt for", platform, ":", prompt); // Optional: for debugging the exact prompt
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        let platformPostsTexts = [];
        try {
          platformPostsTexts = JSON.parse(text);
          if (
            !Array.isArray(platformPostsTexts) ||
            !platformPostsTexts.every((p) => typeof p === "string")
          ) {
            console.warn(
              `Gemini response for ${platform} was not a valid JSON array of strings:`,
              platformPostsTexts,
              "Original raw text from AI:",
              text
            );
            platformPostsTexts = [];
          }
        } catch (parseError) {
          console.warn(
            `Could not parse Gemini response for ${platform} as JSON:`,
            parseError.message,
            "Original raw text from AI:",
            text
          );
          platformPostsTexts = [];
        }

        return {
          platformName: platform.toLowerCase(),
          posts: platformPostsTexts.map((postText) => ({
            text: postText,
            generated_at: new Date().toISOString(),
            model_used: modelName,
          })),
        };
      });

      const settledPlatformResults = await Promise.allSettled(
        platformGenerationPromises
      );

      generatedPosts = settledPlatformResults.reduce((acc, result) => {
        if (result.status === "fulfilled" && result.value) {
          acc[result.value.platformName] = result.value.posts;
        } else if (result.status === "rejected") {
          // Log the error for the specific platform that failed
          // You could choose to store a placeholder or error message for this platform if needed
          console.error(
            `Failed to generate content for a platform:`,
            result.reason
          );
        }
        return acc;
      }, {});

      // Check if any posts were successfully generated before trying to save
      if (Object.keys(generatedPosts).length === 0) {
        console.error(
          "No social posts were successfully generated from AI after parallel execution."
        );
        // Depending on desired behavior, you might return an error or an empty socialPosts object
        // For now, let's return the error that led to Promise.allSettled catching issues if it was an aiError
        // This might need more nuanced error reporting if specific platforms fail vs a total AI outage
        return res.status(500).json({
          error: "Failed to generate any social posts from AI.",
          details:
            "All platform generation attempts either failed or returned no content.",
        });
      }
    } catch (aiError) {
      // This catch block might be less likely to be hit for individual AI call errors if using allSettled
      console.error(
        "Error during the AI content generation process (Promise.allSettled context):",
        aiError
      );
      return res.status(500).json({
        error: "Failed to generate social posts from AI",
        details: aiError.message,
      });
    }
    // --- END ACTUAL AI INTEGRATION ---

    // Persist the newly generated posts
    const updatedLink = await db.updateAISocialPosts(
      buy_short_code,
      generatedPosts
    );
    if (!updatedLink) {
      // This case should ideally not be hit if the initial link fetch was successful
      console.error(
        `Failed to update AI social posts for buy_short_code: ${buy_short_code} after generation.`
      );
      return res
        .status(500)
        .json({ error: "Failed to store generated social posts." });
    }

    res.status(200).json({
      linkId: link.link_hash,
      buyShortCode: link.buy_short_code,
      shareableBuyLink: shareableBuyLink,
      socialPosts: generatedPosts,
      source: "generated",
    });
  } catch (error) {
    console.error(`Error in /social/${buy_short_code} endpoint:`, error);
    res.status(500).json({
      error: "Failed to generate or retrieve social posts",
      details: error.message,
    });
  }
});

app.listen(port, () => {
  console.log(`GivaBit server listening on port ${port}`);
  console.log(`Access the GivaBit interface at: http://localhost:${port}/`);

  const givabitAppPath = GIVABIT_BASE_URL.startsWith("http")
    ? new URL(GIVABIT_BASE_URL).pathname
    : GIVABIT_BASE_URL;
  if (
    givabitAppPath &&
    givabitAppPath !== "/" &&
    !GIVABIT_BASE_URL.startsWith(`http://localhost:${port}`) &&
    !GIVABIT_BASE_URL.startsWith(`https://localhost:${port}`)
  ) {
    console.log(
      `Note: Shareable content links will be constructed using the base URL: ${GIVABIT_BASE_URL}`
    );
  }

  console.log("Defined API endpoints:");
  console.log("  POST   /create-gated-link");
  console.log("  GET    /content/:access_short_code");
  console.log("  GET    /buy/:buy_short_code");
  console.log("  GET    /links/creator/:creatorAddress");
  console.log("  PATCH  /links/:link_hash/status");
  console.log("  GET    /metadata/:buy_short_code");
  console.log("  GET    /social/:buy_short_code");
  console.log("  POST   /create-link-intent");
});
