const axios = require("axios");

const BASE_URL = "https://nhentai.net";
const API_URL = `${BASE_URL}/api/v2`;

const client = axios.create({
    timeout: 20000,
    headers: {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36",
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

    // https://nhentai.net/g/123456/
    const urlMatch = text.match(/nhentai\.net\/g\/(\d+)/i);
    if (urlMatch) return urlMatch[1];

    // Direct numeric ID
    if (/^\d+$/.test(text)) return text;

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

function extensionFromType(type) {
    const value = String(type || "").toLowerCase();

    if (value === "p") return "png";
    if (value === "g") return "gif";
    if (value === "w") return "webp";

    return "jpg";
}

async function getGallery(id) {
    const urls = [
        `${API_URL}/galleries/${id}`,
        `${BASE_URL}/api/gallery/${id}`
    ];

    let lastError = null;

    for (const url of urls) {
        try {
            const response = await client.get(url);

            if (response.data && response.data.id) {
                return response.data;
            }
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error("Gallery not found.");
}

async function searchGallery(title) {
    const response = await client.get(`${API_URL}/search`, {
        params: {
            query: title,
            sort: "popular",
            page: 1
        }
    });

    const results = response.data?.results || [];

    if (!results.length) {
        throw new Error(`No nHentai results found for "${title}".`);
    }

    const wanted = cleanTitle(title);

    // Prefer an exact title match.
    const exact = results.find(item => {
        const titles = [
            item.title?.english,
            item.title?.pretty,
            item.title?.japanese,
            item.title
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
        throw new Error("Manga/gallery title is required.");
    }

    /*
     * nHentai galleries do not use manga-style chapters.
     *
     * Therefore:
     *
     *   -manga <title> <number>
     *
     * is interpreted as:
     *   <number> = nHentai gallery ID
     *
     * when the supplied number is a valid gallery ID.
     */

    let gallery;

    const directId =
        getGalleryId(query) ||
        (/^\d+$/.test(chapterNumber) ? chapterNumber : null);

    if (directId) {
        gallery = await getGallery(directId);
    } else {
        const result = await searchGallery(query);
        gallery = await getGallery(result.id);
    }

    const mediaId = gallery.media_id;

    if (!mediaId) {
        throw new Error("nHentai gallery has no media ID.");
    }

    const pageCount = Number(gallery.num_pages || 0);

    if (!pageCount) {
        throw new Error("nHentai gallery contains no pages.");
    }

    const pages = [];

    /*
     * nHentai image servers use:
     *
     * i.nhentai.net/galleries/{media_id}/{page}.{extension}
     *
     * Page extensions come from the gallery's `images.pages` data.
     */
    for (let i = 0; i < pageCount; i++) {
        const pageData = gallery.images?.pages?.[i];
        const type = pageData?.t || "j";
        const extension = extensionFromType(type);

        pages.push(
            `https://i.nhentai.net/galleries/${mediaId}/${i + 1}.${extension}`
        );
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
