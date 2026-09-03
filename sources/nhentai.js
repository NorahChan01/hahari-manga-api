const axios = require("axios");

const BASE_URL = "https://nhentai.net";
const API_URL = `${BASE_URL}/api/v2`;
const IMAGE_BASE = "https://i.nhentai.net";

const client = axios.create({
    timeout: 20000,
    headers: {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Referer": `${BASE_URL}/`
    }
});

function cleanTitle(title) {
    return String(title || "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function getGalleryId(input) {
    const text = String(input || "").trim();

    const urlMatch = text.match(
        /(?:https?:\/\/)?(?:www\.)?nhentai\.net\/g\/(\d+)/i
    );

    if (urlMatch) {
        return urlMatch[1];
    }

    if (/^\d+$/.test(text)) {
        return text;
    }

    return null;
}

function getTitle(gallery) {
    return (
        gallery?.title?.english ||
        gallery?.title?.pretty ||
        gallery?.title?.japanese ||
        `nHentai Gallery ${gallery?.id || ""}`
    ).trim();
}

/*
 * nHentai image type mapping:
 *
 * j = jpg
 * p = png
 *
 * The type MUST come from images.pages[i].t.
 */
function getExtension(type) {
    switch (String(type || "").toLowerCase()) {
        case "j":
            return "jpg";

        case "p":
            return "png";

        default:
            throw new Error(
                `Unsupported nHentai image type: ${type}`
            );
    }
}

async function getGallery(id) {
    const response = await client.get(
        `${API_URL}/galleries/${encodeURIComponent(id)}`
    );

    if (!response.data || !response.data.id) {
        throw new Error("Invalid nHentai gallery response.");
    }

    return response.data;
}

async function searchGallery(query) {
    const response = await client.get(`${API_URL}/search`, {
        params: {
            query,
            sort: "popular",
            page: 1
        }
    });

    const results = response.data?.results || [];

    if (!results.length) {
        throw new Error(
            `No nHentai results found for "${query}".`
        );
    }

    const wanted = cleanTitle(query);

    const exact = results.find(result => {
        const titles = [
            result.title?.english,
            result.title?.pretty,
            result.title?.japanese
        ]
            .filter(Boolean)
            .map(cleanTitle);

        return titles.includes(wanted);
    });

    return exact || results[0];
}

async function getChapter(title, chapter) {
    const query = String(title || "").trim();
    const chapterNumber = String(chapter || "").trim();

    if (!query) {
        throw new Error("nHentai gallery ID or title is required.");
    }

    let gallery;

    /*
     * Direct gallery ID:
     *
     * -manga 263492
     */
    const directId =
        getGalleryId(query) ||
        (/^\d+$/.test(chapterNumber)
            ? chapterNumber
            : null);

    if (directId) {
        gallery = await getGallery(directId);
    } else {
        /*
         * Title search.
         */
        const result = await searchGallery(query);

        if (!result?.id) {
            throw new Error("Search result has no gallery ID.");
        }

        gallery = await getGallery(result.id);
    }

    const mediaId = gallery.media_id;

    if (!mediaId) {
        throw new Error("Gallery has no media_id.");
    }

    const pageData = gallery.images?.pages;

    if (!Array.isArray(pageData) || !pageData.length) {
        throw new Error("Gallery contains no page data.");
    }

    const pages = [];

    /*
     * Build every page from the ACTUAL image type
     * returned by nHentai.
     *
     * Example:
     *
     * t = "p" -> 1.png
     * t = "j" -> 1.jpg
     */
    for (let i = 0; i < pageData.length; i++) {
        const page = pageData[i];

        const extension = getExtension(page?.t);

        pages.push(
            `${IMAGE_BASE}/galleries/${mediaId}/${i + 1}.${extension}`
        );
    }

    if (!pages.length) {
        throw new Error("Failed to generate gallery page URLs.");
    }

    return {
        title: getTitle(gallery),
        chapter: String(gallery.id),
        source: "nHentai",
        pages
    };
}

module.exports = {
    name: "nHentai",
    getChapter
};
