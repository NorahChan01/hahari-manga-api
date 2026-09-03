const axios = require("axios");

const API = "https://vortexscans.vercel.app/api/v1";

const headers = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/131.0.0.0 Safari/537.36",
    Accept: "application/json"
};

function normalize(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function chapterMatches(value, wanted) {
    if (value === undefined || value === null) {
        return false;
    }

    const a = String(value).trim();
    const b = String(wanted).trim();

    if (a === b) {
        return true;
    }

    const na = Number(a);
    const nb = Number(b);

    return (
        Number.isFinite(na) &&
        Number.isFinite(nb) &&
        na === nb
    );
}

async function get(url, params = {}) {
    return axios.get(url, {
        params,
        headers,
        timeout: 30000
    });
}

module.exports = {
    name: "VortexScans",

    async getChapter(mangaName, chapterNumber) {

        // =====================================================
        // 1. SEARCH MANGA
        // =====================================================

        const searchResponse = await get(
            `${API}/search`,
            {
                q: mangaName,
                page: 1,
                limit: 20
            }
        );

        if (searchResponse.data?.success === false) {
            throw new Error(
                searchResponse.data?.error ||
                "Vortex search failed."
            );
        }

        const results =
            searchResponse.data?.data || [];

        if (
            !Array.isArray(results) ||
            !results.length
        ) {
            throw new Error(
                `No manga found for "${mangaName}".`
            );
        }

        // =====================================================
        // 2. FIND BEST TITLE MATCH
        // =====================================================

        const query =
            normalize(mangaName);

        let manga = results.find(item => {
            return normalize(item.title) === query;
        });

        if (!manga) {

            manga = results.find(item => {

                const title =
                    normalize(item.title);

                return (
                    title.includes(query) ||
                    query.includes(title)
                );
            });
        }

        if (!manga) {
            manga = results[0];
        }

        const slug = manga.slug;

        const title =
            manga.title ||
            mangaName;

        if (!slug) {
            throw new Error(
                "Vortex search result has no manga slug."
            );
        }

        // =====================================================
        // 3. GET CHAPTERS
        // =====================================================

        let chapters = [];

        let page = 1;

        const MAX_PAGES = 20;

        while (page <= MAX_PAGES) {

            const response = await get(
                `${API}/manga/${encodeURIComponent(slug)}/chapters`,
                {
                    page,
                    limit: 100
                }
            );

            if (response.data?.success === false) {
                throw new Error(
                    response.data?.error ||
                    "Vortex chapter request failed."
                );
            }

            const data =
                response.data?.data;

            const pageChapters =
                data?.chapters || [];

            if (
                !Array.isArray(pageChapters) ||
                !pageChapters.length
            ) {
                break;
            }

            chapters.push(
                ...pageChapters
            );

            const pagination =
                response.data?.pagination;

            if (
                !pagination?.hasNext
            ) {
                break;
            }

            page++;
        }

        if (!chapters.length) {
            throw new Error(
                `No chapters found for "${title}".`
            );
        }

        // =====================================================
        // 4. FIND REQUESTED CHAPTER
        // =====================================================

        const chapter =
            chapters.find(ch =>
                chapterMatches(
                    ch.number,
                    chapterNumber
                )
            );

        if (!chapter) {

            throw new Error(
                `Chapter ${chapterNumber} was not found on VortexScans.`
            );
        }

        const chapterID =
            chapter.id;

        if (!chapterID) {
            throw new Error(
                "Vortex chapter has no chapter ID."
            );
        }

        // =====================================================
        // 5. GET CHAPTER IMAGES
        // =====================================================

        const chapterResponse =
            await get(
                `${API}/chapter/${chapterID}`
            );

        if (
            chapterResponse.data?.success === false
        ) {
            throw new Error(
                chapterResponse.data?.error ||
                "Vortex chapter request failed."
            );
        }

        const chapterData =
            chapterResponse.data?.data;

        if (!chapterData) {
            throw new Error(
                "Vortex returned no chapter data."
            );
        }

        const images =
            chapterData.images || [];

        if (
            !Array.isArray(images) ||
            !images.length
        ) {
            throw new Error(
                "Vortex returned no chapter images."
            );
        }

        // =====================================================
        // 6. CLEAN IMAGE URLS
        // =====================================================

        const pages = images
            .map(image => {

                if (
                    typeof image !== "string"
                ) {
                    return null;
                }

                const url =
                    image.trim();

                if (!url) {
                    return null;
                }

                if (
                    url.startsWith("http://") ||
                    url.startsWith("https://")
                ) {
                    return url;
                }

                return null;
            })
            .filter(Boolean);

        if (!pages.length) {
            throw new Error(
                "Vortex returned invalid image URLs."
            );
        }

        // =====================================================
        // 7. RETURN STANDARD FORMAT
        // =====================================================

        return {
            title:
                chapterData.series?.title ||
                title,

            chapter:
                String(
                    chapterData.number ??
                    chapter.number ??
                    chapterNumber
                ),

            pages
        };
    }
};
