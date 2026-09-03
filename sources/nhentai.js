const axios = require("axios");

const API = "https://nhentai.net/api/v2";
const IMAGE_BASE = "https://i.nhentai.net";

const client = axios.create({
    timeout: 20000,
    headers: {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/128.0.0.0 Safari/537.36",
        Accept: "application/json"
    }
});

function extension(type) {
    switch (String(type || "").toLowerCase()) {
        case "p":
            return "png";

        case "j":
            return "jpg";

        case "g":
            return "gif";

        case "w":
            return "webp";

        default:
            return "jpg";
    }
}

function extractGallery(data) {
    // Normal v2 response
    if (data?.id) return data;

    // Some wrappers/API proxies wrap the result.
    if (data?.result?.id) return data.result;

    if (data?.data?.id) return data.data;

    if (data?.gallery?.id) return data.gallery;

    return null;
}

async function getGallery(id) {
    const urls = [
        `${API}/galleries/${id}`,
        `https://nhentai.net/api/gallery/${id}`
    ];

    let lastError = null;

    for (const url of urls) {
        try {
            const response = await client.get(url);

            const gallery = extractGallery(response.data);

            if (gallery?.id) {
                return gallery;
            }

            lastError = new Error(
                "nHentai returned an invalid gallery response."
            );
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error("Gallery not found.");
}

function getId(input) {
    const text = String(input || "").trim();

    const urlMatch = text.match(
        /nhentai\.net\/g\/(\d+)/i
    );

    if (urlMatch) {
        return urlMatch[1];
    }

    if (/^\d+$/.test(text)) {
        return text;
    }

    return null;
}

async function search(query) {
    const response = await client.get(`${API}/search`, {
        params: {
            query,
            page: 1,
            sort: "popular"
        }
    });

    const results = response.data?.results;

    if (!Array.isArray(results) || !results.length) {
        throw new Error(
            `No nHentai results found for "${query}".`
        );
    }

    return results[0];
}

function getPageTypes(gallery) {
    /*
     * Official/current v2 structure:
     *
     * gallery.images.pages[]
     *
     * Each page contains:
     *
     * t = "j" -> JPG
     * t = "p" -> PNG
     * t = "g" -> GIF
     */

    const pages = gallery?.images?.pages;

    if (Array.isArray(pages) && pages.length) {
        return pages.map(page => extension(page?.t));
    }

    /*
     * Fallback for unusual API wrappers.
     *
     * If the page metadata isn't exposed but the gallery
     * itself reports a page count, default to JPG.
     *
     * This keeps the adapter from falsely declaring that
     * the gallery has no pages.
     */
    const count = Number(gallery?.num_pages || 0);

    if (count > 0) {
        return Array(count).fill("jpg");
    }

    return [];
}

async function getChapter(title, chapter) {
    const titleInput = String(title || "").trim();
    const chapterInput = String(chapter || "").trim();

    if (!titleInput) {
        throw new Error("nHentai gallery ID or title is required.");
    }

    /*
     * Preferred usage:
     *
     * -manga 263492
     *
     * The number is treated as the nHentai gallery ID.
     */
    let galleryId =
        getId(titleInput) ||
        (/^\d+$/.test(chapterInput)
            ? chapterInput
            : null);

    let gallery;

    if (galleryId) {
        gallery = await getGallery(galleryId);
    } else {
        const result = await search(titleInput);

        if (!result?.id) {
            throw new Error("Search result has no gallery ID.");
        }

        galleryId = String(result.id);
        gallery = await getGallery(galleryId);
    }

    const mediaId = gallery.media_id;

    if (!mediaId) {
        throw new Error("Gallery has no media_id.");
    }

    const pageTypes = getPageTypes(gallery);

    if (!pageTypes.length) {
        throw new Error("Gallery contains no pages.");
    }

    const pages = pageTypes.map((ext, index) => {
        return `${IMAGE_BASE}/galleries/${mediaId}/${index + 1}.${ext}`;
    });

    return {
        title:
            gallery.title?.english ||
            gallery.title?.pretty ||
            gallery.title?.japanese ||
            `nHentai Gallery ${gallery.id}`,

        chapter: String(gallery.id),

        source: "nHentai",

        pages
    };
}

module.exports = {
    name: "nHentai",
    getChapter
};
