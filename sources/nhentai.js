const axios = require("axios");

const API_BASE = "https://nhentai.net/api/v2";
const IMAGE_BASE = "https://i.nhentai.net";

const client = axios.create({
    timeout: 30000,
    maxRedirects: 5,
    headers: {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/139.0.0.0 Safari/537.36",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9"
    }
});

function getGalleryId(value) {
    const text = String(value || "").trim();

    /*
     * Accept:
     *
     * 263492
     * https://nhentai.net/g/263492/
     */
    const urlMatch =
        text.match(
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

function absoluteImage(path) {
    if (!path) return null;

    const value =
        String(path).trim();

    if (!value) return null;

    if (/^https?:\/\//i.test(value)) {
        return value;
    }

    return `${IMAGE_BASE}/${value.replace(/^\/+/, "")}`;
}

async function getGallery(id) {
    const url =
        `${API_BASE}/galleries/${encodeURIComponent(id)}`;

    try {
        const response =
            await client.get(url);

        if (
            !response.data ||
            !response.data.id
        ) {
            throw new Error(
                "nHentai returned an invalid gallery."
            );
        }

        return response.data;

    } catch (error) {

        if (error.response) {

            throw new Error(
                `nHentai API returned HTTP ${error.response.status}.`
            );
        }

        throw new Error(
            `Failed to contact nHentai API: ${error.message}`
        );
    }
}

async function searchGallery(query) {

    const response =
        await client.get(
            `${API_BASE}/search`,
            {
                params: {
                    query,
                    page: 1,
                    sort: "popular"
                }
            }
        );

    const results =
        response.data?.results;

    if (
        !Array.isArray(results) ||
        !results.length
    ) {
        return null;
    }

    return results[0];
}

module.exports = {

    name: "nHentai",

    async getChapter(
        title,
        chapter
    ) {

        const titleText =
            String(title || "").trim();

        const chapterText =
            String(chapter || "").trim();

        if (!titleText) {
            throw new Error(
                "Gallery ID or title is required."
            );
        }

        /*
         * Preferred:
         *
         * -manga 263492
         *
         * Also supports:
         *
         * -manga https://nhentai.net/g/263492/
         */
        let galleryId =
            getGalleryId(titleText);

        /*
         * If the ID was passed as chapter:
         *
         * /api/manga?title=263492&chapter=1
         */
        if (
            !galleryId &&
            /^\d+$/.test(chapterText)
        ) {
            galleryId =
                chapterText;
        }

        let gallery;

        /*
         * Direct gallery lookup.
         */
        if (galleryId) {

            gallery =
                await getGallery(
                    galleryId
                );

        } else {

            /*
             * Title search fallback.
             */
            const result =
                await searchGallery(
                    titleText
                );

            if (!result?.id) {
                throw new Error(
                    `No nHentai gallery found for "${titleText}".`
                );
            }

            galleryId =
                String(result.id);

            gallery =
                await getGallery(
                    galleryId
                );
        }

        /*
         * The v2 API provides:
         *
         * gallery.media_id
         * gallery.pages[]
         *
         * Each page already contains the exact
         * image path, e.g.
         *
         * galleries/1367250/1.png
         *
         * Do NOT guess jpg/png anymore.
         */
        const apiPages =
            Array.isArray(
                gallery.pages
            )
                ? gallery.pages
                : [];

        if (!apiPages.length) {

            throw new Error(
                `Gallery ${gallery.id} contains no page data.`
            );
        }

        const pages =
            apiPages
                .map(page => {

                    /*
                     * Current v2 format:
                     *
                     * {
                     *   number: 1,
                     *   path: "galleries/1367250/1.png",
                     *   width: 1280,
                     *   height: 1803
                     * }
                     */
                    return absoluteImage(
                        page?.path
                    );
                })
                .filter(Boolean);

        if (!pages.length) {

            throw new Error(
                `Gallery ${gallery.id} returned page metadata but no usable image paths.`
            );
        }

        return {

            title:
                gallery.title?.english ||
                gallery.title?.pretty ||
                gallery.title?.japanese ||
                `nHentai Gallery ${gallery.id}`,

            chapter:
                String(
                    gallery.id
                ),

            source:
                "nHentai",

            pages
        };
    }
};
