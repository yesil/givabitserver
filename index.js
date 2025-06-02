require('dotenv').config(); // Load environment variables from .env file

const express = require('express')
const crypto = require('crypto') // Used for generating mock transaction hashes
const ethers = require('ethers')
const { nanoid } = require('nanoid')
const path = require('path'); // Ensure path module is required
const playwright = require('playwright');
const { google } = require('googleapis');

// Database interactions
const db = require('./database');

// Blockchain interactions
const { createLinkOnChain, setLinkActivityOnChain } = require('./blockchain')

const app = express()
const port = process.env.PORT || 3000

// Serve apple-app-site-association with correct content type
app.get('/.well-known/apple-app-site-association', (req, res) => {
	res.type('application/json');
	res.sendFile(path.join(__dirname, 'public', 'apple-app-site-association'));
});

// Serve apple-app-site-association at root for flexibility (some CDNs/proxies might not serve .well-known correctly)
app.get('/apple-app-site-association', (req, res) => {
	res.type('application/json');
	res.sendFile(path.join(__dirname, 'public', 'apple-app-site-association'));
});

app.use(express.json()) // Middleware to parse JSON request bodies
app.use(express.static('public')); // Serve static files from 'public' directory

const GIVABIT_BASE_URL = process.env.GIVABIT_APP_URL || 'https://givabit-server-krlus.ondigitalocean.app'
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

const youtube = google.youtube({
    version: 'v3',
    auth: YOUTUBE_API_KEY,
});

/**
 * Generates a keccak256 hash for a given string (URL).
 * @param {string} data The string to hash.
 * @returns {string} The hex string of the hash, prefixed with 0x.
 */
function generateLinkHash(data) {
	// Ensure the data is UTF-8 encoded bytes before hashing
	const dataBytes = ethers.toUtf8Bytes(data)
	return ethers.keccak256(dataBytes)
}

/**
 * Generates a short unique code using nanoid.
 * @returns {string} A short unique identifier.
 */
function generateShortCode() {
	return nanoid(7) // Generates a 7-character short ID, e.g., 'abc123X'
}

// --- API Endpoints --- 

// req1: POST /create-gated-link
app.post('/create-gated-link', async (req, res) => {
	const { url, title, priceInERC20, creatorAddress } = req.body

	if (!url || !priceInERC20 || !creatorAddress) { // Title is optional
		return res.status(400).json({ error: 'Missing required fields: url, priceInERC20, creatorAddress' })
	}

	try {
		const linkHash = generateLinkHash(url) // Hash is based on URL, not title
		const buyShortCode = generateShortCode()
		const accessShortCode = generateShortCode()

		// 1. Smart Contract Interaction
		let actualTxHash = '0xmockTransactionHash_default_' + crypto.randomBytes(10).toString('hex'); // Default mock
		try {
		  const txReceipt = await createLinkOnChain(linkHash, creatorAddress, priceInERC20, true);
		  actualTxHash = txReceipt.transactionHash;
		  console.log('Blockchain transaction successful:', actualTxHash);
		} catch (blockchainError) {
		  console.error('Blockchain interaction failed:', blockchainError.message);
		  // For critical failure like this, returning an error might be appropriate
		  return res.status(500).json({ error: 'Smart contract interaction failed', details: blockchainError.message });
		}

		// 2. Database Storage
		try {
			await db.storeGatedLink({
				original_url: url,
				link_hash: linkHash,
				buy_short_code: buyShortCode,
				access_short_code: accessShortCode,
				title: title, // Add title here
				creator_address: creatorAddress,
				price_in_erc20: priceInERC20,
				tx_hash: actualTxHash,
				is_active: true,
			});
		} catch (dbError) {
			console.error('Database storage failed:', dbError.message);
			// If blockchain call was made, this could lead to inconsistent state.
			// Consider compensation logic or more robust error handling.
			return res.status(500).json({ error: 'Failed to store link details in database', details: dbError.message });
		}

		const shareableBuyLink = `${GIVABIT_BASE_URL}/buy/${buyShortCode}`

		res.status(201).json({
			linkId: linkHash,
			buyShortCode: buyShortCode,
			accessShortCode: accessShortCode,
			originalUrl: url,
			title: title, // Include title in response
			creatorAddress: creatorAddress,
			priceInERC20: priceInERC20,
			transactionHash: actualTxHash, 
			shareableBuyLink: shareableBuyLink
		})
	} catch (error) {
		console.error('Error creating gated link:', error)
		// Differentiate between blockchain errors, db errors, etc.
		res.status(500).json({ error: 'Failed to create gated link', details: error.message })
	}
})

// req1: GET /content/:access_short_code
app.get('/content/:access_short_code', async (req, res) => {
	const { access_short_code } = req.params
	try {
		// Database Query
		const link = await db.getLinkByAccessShortCode(access_short_code);
		// const mockLink = { original_url: 'https://example.com/mock-redirect-target' } // Placeholder

		if (link && link.original_url) {
			// Future: Add access check via smart contract here
			// For now, also check if link is active in DB
			if (!link.is_active) {
				return res.status(403).json({ error: 'This link is currently inactive.' });
			}
			res.redirect(302, link.original_url)
		} else {
			res.status(404).json({ error: 'Content not found' })
		}
	} catch (error) {
		console.error(`Error fetching content for access_short_code ${access_short_code}:`, error)
		res.status(500).json({ error: 'Failed to retrieve content', details: error.message })
	}
})

// Renamed from /social-posts by user
app.get('/generate', async (req, res) => {
	const { linkHash, walletAddress } = req.query // walletAddress is for context/future use as per PRD

	if (!linkHash || !walletAddress) {
		return res.status(400).json({ error: 'Missing required query parameters: linkHash, walletAddress' })
	}

	try {
		// Database Query to get buy_short_code using linkHash
		const link = await db.getLinkByHash(linkHash);
		if (!link || !link.buy_short_code) {
		  return res.status(404).json({ error: 'Link not found or missing buy_short_code for the given hash' })
		}
		const buyShortCode = link.buy_short_code;
		// const mockShortCode = generateShortCode() // Use the actual function for consistency in mock data

		const shareableBuyLink = `${GIVABIT_BASE_URL}/buy/${buyShortCode}`

		const socialPosts = {
			twitter: `Check out my new content! Purchase access here: ${shareableBuyLink} #GivaBit #ContentMonetization`,
			instagram: `New exclusive content! Get access: ${shareableBuyLink} #GivaBit #ExclusiveContent`
		}

		res.status(200).json({
			linkId: linkHash,
			buyShortCode: buyShortCode, 
			shareableBuyLink: shareableBuyLink,
			socialPosts: socialPosts
		})
	} catch (error) {
		console.error('Error generating social posts:', error)
		res.status(500).json({ error: 'Failed to generate social posts', details: error.message })
	}
})

// New endpoint for buy/purchase landing (primarily for mobile app)
app.get('/buy/:buy_short_code', async (req, res) => {
	const { buy_short_code } = req.params;

	try {
		const link = await db.getLinkByBuyShortCode(buy_short_code);

		if (!link) {
			return res.status(404).json({ error: 'Purchase link not found.' });
		}

		if (!link.is_active) {
			return res.status(403).json({ error: 'This link is currently inactive and cannot be purchased.' });
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
			isActiveOnDb: link.is_active // Status from DB
			// isActiveOnChain: isActiveOnChain // Add if fetching from SC
		});

	} catch (error) {
		console.error(`Error fetching buy link details for ${buy_short_code}:`, error);
		res.status(500).json({ error: 'Failed to retrieve purchase link details', details: error.message });
	}
});

// PATCH /links/{link_hash}/status
app.patch('/links/:link_hash/status', async (req, res) => {
	const { link_hash } = req.params
	const { isActive } = req.body

	if (typeof isActive !== 'boolean') {
		return res.status(400).json({ error: 'Invalid request body: isActive (boolean) is required.' })
	}

	try {
		// Verify link exists (optional but good practice)
		const linkExists = await db.getLinkByHash(link_hash);
		if (!linkExists) {
			return res.status(404).json({ error: 'Link not found with the provided hash.' });
		}

		// 1. Smart Contract Interaction
		let actualUpdateTxHash = '0xmockUpdateTxHash_default_' + crypto.randomBytes(10).toString('hex'); // Default mock
		try {
		  const txReceipt = await setLinkActivityOnChain(link_hash, isActive);
		  actualUpdateTxHash = txReceipt.transactionHash;
		  console.log('Blockchain status update successful:', actualUpdateTxHash);
		} catch (blockchainError) {
		  console.error('Blockchain interaction for status update failed:', blockchainError.message);
		  return res.status(500).json({ error: 'Smart contract interaction failed for status update', details: blockchainError.message });
		}

		// 2. Database Update
		try {
			await db.updateLinkStatus(link_hash, isActive, actualUpdateTxHash);
		} catch (dbError) {
			console.error(`Database update for link status failed for ${link_hash}:`, dbError.message);
			// If blockchain call was made, this could lead to inconsistent state.
			return res.status(500).json({ error: 'Failed to update link status in database', details: dbError.message });
		}

		res.status(200).json({
			linkId: link_hash,
			isActive: isActive,
			message: 'Link status updated successfully.',
			transactionHash: actualUpdateTxHash 
		})
	} catch (error) {
		console.error(`Error updating status for link ${link_hash}:`, error)
		res.status(500).json({ error: 'Failed to update link status', details: error.message })
	}
})

// Endpoint to get links by creatorAddress
app.get('/links/creator/:creatorAddress', async (req, res) => {
	let { creatorAddress } = req.params; // Use let to allow reassignment

	// Validate creatorAddress format before normalization
	if (!creatorAddress || typeof creatorAddress !== 'string' || !creatorAddress.startsWith('0x')) { 
		return res.status(400).json({ error: 'Invalid creatorAddress format.' });
	}

	// Normalize to lowercase for consistent querying
	creatorAddress = creatorAddress.toLowerCase();

	try {
		const links = await db.getLinksByCreator(creatorAddress);
		
		const formattedLinks = links.map(link => {
			const shareableBuyLink = `${GIVABIT_BASE_URL}/buy/${link.buy_short_code}`;
			return {
				linkId: link.link_hash,
				buyShortCode: link.buy_short_code,
				accessShortCode: link.access_short_code,
				originalUrl: link.original_url,
				title: link.title, // Add title here
				priceInERC20: link.price_in_erc20,
				isActive: link.is_active,
				createdAt: link.created_at,
				shareableBuyLink: shareableBuyLink,
				socialPosts: {
					twitter: `Check out my new content! Purchase access here: ${shareableBuyLink} #GivaBit #ContentMonetization`,
					instagram: `New exclusive content! Get access: ${shareableBuyLink} #GivaBit #ExclusiveContent`
				}
			};
		});

		console.log('Formatted links for creator:', creatorAddress, JSON.stringify(formattedLinks, null, 2)); // Log the formatted links

		res.status(200).json({
			links: formattedLinks
		});
	} catch (error) {
		console.error(`Error fetching links for creator ${creatorAddress}:`, error);
		res.status(500).json({ error: 'Failed to retrieve links for creator', details: error.message });
	}
});

// New endpoint to get title by buy_short_code
app.get('/info/:buy_short_code', async (req, res) => {
	const { buy_short_code } = req.params;

	// Predefined list of descriptions
	const descriptions = [
		"Unlock exclusive content and dive deeper into the story.",
		"Get access to premium material not available anywhere else.",
		"Discover the secrets behind this amazing creation.",
		"Support the creator and enjoy this unique piece of content.",
		"Your gateway to an enhanced experience."
	];

	try {
		const link = await db.getLinkByBuyShortCode(buy_short_code);

		if (!link) {
			return res.status(404).json({ error: 'Link not found for the given buy short code.' });
		}

		// Optionally, you could also check if the link is active, depending on requirements
		// if (!link.is_active) {
		//    return res.status(403).json({ error: 'This link is currently inactive.' });
		// }

		const randomDescription = descriptions[Math.floor(Math.random() * descriptions.length)];

		res.status(200).json({
			buyShortCode: link.buy_short_code,
			title: link.title,
			description: randomDescription // Add the random description here
		});

	} catch (error) {
		console.error(`Error fetching title for buy_short_code ${buy_short_code}:`, error);
		res.status(500).json({ error: 'Failed to retrieve title', details: error.message });
	}
});

// --- Helper functions for metadata extraction ---

async function getYoutubeVideoDetails(youtubeUrl) {
    try {
        const videoId = extractYoutubeVideoId(youtubeUrl);
        if (!videoId) {
            throw new Error('Invalid YouTube URL or unable to extract video ID.');
        }

        if (!YOUTUBE_API_KEY) {
            console.warn('YOUTUBE_API_KEY not configured. Cannot fetch YouTube video details.');
            return {
                title: 'YouTube Video (ID: ' + videoId + ')',
                description: 'API key not configured to fetch full details.',
            };
        }

        const response = await youtube.videos.list({
            part: 'snippet,contentDetails',
            id: videoId,
        });

        if (!response.data.items || response.data.items.length === 0) {
            throw new Error('Video not found or API error.');
        }

        const video = response.data.items[0];
        const snippet = video.snippet;
        // const contentDetails = video.contentDetails; // Contains duration, dimension etc.

        const thumbnails = snippet.thumbnails;
        const thumbnailUrl = thumbnails.maxres?.url || thumbnails.high?.url || thumbnails.medium?.url || thumbnails.default?.url;

        return {
            title: snippet.title,
            description: snippet.description,
            author_name: snippet.channelTitle,
            // author_profile_picture_url: null, // YouTube API for videos doesn't directly give channel profile pic. Need separate channels.list call.
            content_vignette_url: thumbnailUrl,
            publication_date: snippet.publishedAt ? new Date(snippet.publishedAt) : null,
            // extracted_metadata: { duration: contentDetails.duration } // Example
        };
    } catch (error) {
        console.error(`Error fetching YouTube video details for ${youtubeUrl}:`, error.message);
        // Return a generic title if API fails or videoId is bad
        const videoId = extractYoutubeVideoId(youtubeUrl) || 'unknown_id';
        return {
            title: `YouTube Video (ID: ${videoId})`,
            description: `Could not fetch details: ${error.message}`,
        };
    }
}

function extractYoutubeVideoId(url) {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

async function getGenericPageMetadata(url) {
    let browser = null;
    try {
        // Launch browser. Chromium is generally well-supported.
        // You might need to install browser binaries if they are not found: npx playwright install
        browser = await playwright.chromium.launch({ headless: true });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        });
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }); // Wait for network to be idle, timeout after 30s

        const metadata = await page.evaluate(() => {
            const getMetaContent = (name) => {
                const element = document.querySelector(`meta[name="${name}"]`) || document.querySelector(`meta[property="${name}"]`);
                return element ? element.content : null;
            };

            let title = getMetaContent('og:title') || getMetaContent('twitter:title') || document.title;
            let description = getMetaContent('og:description') || getMetaContent('twitter:description') || getMetaContent('description');
            let authorName = getMetaContent('author') || getMetaContent('og:site_name'); // or specific author tags if known
            let profilePicUrl = getMetaContent('og:image:secure_url') || getMetaContent('og:image') || getMetaContent('twitter:image'); // This is often content image, not author profile
            let contentVignetteUrl = profilePicUrl; // Reuse, or look for specific article image
            let publicationDate = getMetaContent('article:published_time') || getMetaContent('og:updated_time');

            // Try to clean up title and description
            if (title) title = title.trim();
            if (description) description = description.trim();
            if (authorName) authorName = authorName.trim();


            // More specific selectors if needed:
            // Example: const h1Title = document.querySelector('h1')?.innerText;
            // if (!title && h1Title) title = h1Title;

            return {
                title: title || 'Untitled Page',
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
        console.error(`Playwright - Error fetching generic page metadata for ${url}:`, error.message);
        if (browser) {
            await browser.close();
        }
        return {
            title: `Web Page at ${url.substring(0,50)}...`, // Truncate long URLs
            description: `Could not fetch details: ${error.message}`,
        };
    }
}

// --- New Metadata Endpoint ---
app.get('/metadata/:link_hash', async (req, res) => {
    const { link_hash } = req.params;

    try {
        const link = await db.getLinkByHash(link_hash);
        if (!link) {
            return res.status(404).json({ error: 'Link not found with the provided hash.' });
        }

        // Check if metadata already exists and is recent enough (e.g., less than 24 hours old)
        // For simplicity, we'll always re-fetch for now, but caching would be good.
        // const metadataIsRecent = link.updated_at && (new Date() - new Date(link.updated_at)) < 24 * 60 * 60 * 1000;
        // if (link.title && link.description && metadataIsRecent) { // Basic check
        //    return res.status(200).json({ /* ... existing link data ... */ });
        // }
        
        let extractedData = {};
        const originalUrl = link.original_url;

        if (extractYoutubeVideoId(originalUrl)) {
            console.log(`Fetching metadata for YouTube URL: ${originalUrl}`);
            extractedData = await getYoutubeVideoDetails(originalUrl);
        } else {
            console.log(`Fetching metadata for generic URL: ${originalUrl}`);
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
            extracted_metadata: extractedData.extracted_metadata // Store any extra bits here
        };
        
        // Update the database with the new metadata
        // We need a new DB function or modify an existing one.
        // For now, let's assume a function `db.updateLinkMetadata` exists.
        // This function would be:
        // async function updateLinkMetadata(linkHash, metadata) {
        //   const sql = \`UPDATE GatedLinks SET 
        //                  title = $1, description = $2, author_name = $3, 
        //                  author_profile_picture_url = $4, content_vignette_url = $5, 
        //                  publication_date = $6, extracted_metadata = $7,
        //                  updated_at = CURRENT_TIMESTAMP 
        //                WHERE link_hash = $8\`;
        //   const params = [
        //     metadata.title, metadata.description, metadata.author_name,
        //     metadata.author_profile_picture_url, metadata.content_vignette_url,
        //     metadata.publication_date, metadata.extracted_metadata ? JSON.stringify(metadata.extracted_metadata) : null,
        //     linkHash
        //   ];
        //   await pool.query(sql, params);
        // }
        // Since we don't have it yet, we will skip DB update in this step and just return data.
        // In a real scenario, you would call: await db.updateLinkMetadata(link_hash, updatedLinkData);
        await db.updateLinkMetadata(link_hash, updatedLinkData);

        // Prepare response (subset of fields, or all, depending on needs)
        const responseData = {
            linkId: updatedLinkData.link_hash,
            originalUrl: updatedLinkData.original_url,
            title: updatedLinkData.title,
            description: updatedLinkData.description,
            authorName: updatedLinkData.author_name,
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
        console.error(`Error in /metadata/${link_hash} endpoint:`, error);
        res.status(500).json({ error: 'Failed to extract metadata', details: error.message });
    }
});

app.listen(port, () => {
	console.log(`GivaBit server listening on port ${port}`)
	console.log(`Access the GivaBit interface at: http://localhost:${port}/`)
	
	const givabitAppPath = GIVABIT_BASE_URL.startsWith('http') ? new URL(GIVABIT_BASE_URL).pathname : GIVABIT_BASE_URL;
	if (givabitAppPath && givabitAppPath !== "/" && !GIVABIT_BASE_URL.startsWith(`http://localhost:${port}`) && !GIVABIT_BASE_URL.startsWith(`https://localhost:${port}`)) {
		console.log(`Note: Shareable content links will be constructed using the base URL: ${GIVABIT_BASE_URL}`);
	}

	console.log('Defined API endpoints:')
	console.log('  POST   /create-gated-link')
	console.log('  GET    /content/:access_short_code')
	console.log('  GET    /generate?linkHash=...&walletAddress=...')
	console.log('  GET    /buy/:buy_short_code')
	console.log('  GET    /links/creator/:creatorAddress')
	console.log('  PATCH  /links/:link_hash/status')
	console.log('  GET    /info/:buy_short_code')
	console.log('  GET    /metadata/:link_hash') // New endpoint
})
