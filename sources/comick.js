const axios = require("axios");

const API = "https://api.comick.io";
const WEB = "https://comick.io";

const headers = {
    Accept: "application/json",
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Referer: `${WEB}/`
};

function normalize(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function chapterMatches(value, wanted) {
    if (value == null) return false;

    const a = String(value).trim();
    const b = String(wanted).trim();

    if (a === b) return true;

    const na = Number(a);
    const nb = Number(b);

    return (
        Number.isFinite(na) &&
        Number.isFinite(nb) &&
        na === nb
    );
}

async function request(url, config = {}) {
    return axios.get(url, {
        timeout: 30000,
        headers,
        ...config
    });
}

module.exports = {
    name: "Comick",

    async getChapter(mangaName, chapterNumber) {

        // =====================================================
        // 1. SEARCH COMICK
        // =====================================================

        const searchResponse = await request(
            `${API}/v1.0/search`,
            {
                params: {
                    q: mangaName,
                    limit: 10
                }
            }
        );

        const results =
            Array.isArray(searchResponse.data)
                ? searchResponse.data
                : (
                    searchResponse.data?.data ||
                    searchResponse.data?.results ||
                    []
                );

        if (!results.length) {
            throw new Error(
                `No manga found for "${mangaName}".`
            );
        }

        // =====================================================
        // 2. PICK BEST TITLE MATCH
        // =====================================================

        const query = normalize(mangaName);

        let comic = results.find(item => {
            return normalize(
                item.title ||
                item.name ||
                ""
            ) === query;
        });

        // Search result usually has hid/slug.
        // If exact match isn't found, use first result.
        if (!comic) {
            comic = results[0];
        }

        const hid =
            comic.hid ||
            comic.id ||
            comic.comic?.hid;

        if (!hid) {
            throw new Error(
                "Comick search did not return a comic ID."
            );
        }

        const title =
            comic.title ||
            comic.name ||
            comic.comic?.title ||
            mangaName;

        const slug =
            comic.slug ||
            comic.comic?.slug ||
            "";

        // =====================================================
        // 3. FIND CHAPTER
        // =====================================================

        let chapters = [];

        let page = 1;

        const MAX_PAGES = 20;

        while (page <= MAX_PAGES) {

            const response = await request(
                `${API}/comic/${encodeURIComponent(hid)}/chapters`,
                {
                    params: {
                        lang: "en",
                        limit: 100,
                        page,
                        "chap-order": 0
                    }
                }
            );

            const data =
                response.data?.chapters ||
                response.data?.data ||
                [];

            if (!Array.isArray(data) || !data.length) {
                break;
            }

            chapters.push(...data);

            // If fewer than requested, there is
            // probably no next page.
            if (data.length < 100) {
                break;
            }

            page++;
        }

        if (!chapters.length) {
            throw new Error(
                `No English chapters found for "${title}".`
            );
        }

        // =====================================================
        // 4. FIND REQUESTED CHAPTER
        // =====================================================

        let chapter = chapters.find(ch => {
            return chapterMatches(
                ch.chap,
                chapterNumber
            );
        });

        if (!chapter) {
            throw new Error(
                `Chapter ${chapterNumber} was not found on Comick.`
            );
        }

        const chapterHid =
            chapter.hid ||
            chapter.chapter_hid ||
            chapter.id;

        const lang =
            chapter.lang ||
            "en";

        const chap =
            chapter.chap ||
            String(chapterNumber);

        if (!chapterHid) {
            throw new Error(
                "Comick chapter did not return a chapter ID."
            );
        }

        // =====================================================
        // 5. GET CHAPTER PAGE
        // =====================================================

        /*
         * Comick's chapter page contains Next.js data
         * including md_images.
         *
         * This is intentionally separate from MangaDex.
         */

        if (!slug) {
            throw new Error(
                "Comick search did not return a manga slug."
            );
        }

        const chapterURL =
            `${WEB}/comic/${slug}/` +
            `${chapterHid}-chapter-${chap}-${lang}`;

        const pageResponse = await axios.get(
            chapterURL,
            {
                timeout: 30000,
                headers: {
                    ...headers,
                    Accept:
                        "text/html,application/xhtml+xml"
                }
            }
        );

        const html = pageResponse.data;

        if (!html || typeof html !== "string") {
            throw new Error(
                "Comick returned an invalid chapter page."
            );
        }

        // =====================================================
        // 6. EXTRACT __NEXT_DATA__
        // =====================================================

        const nextDataMatch =
            html.match(
                /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
            );

        if (!nextDataMatch) {
            throw new Error(
                "Comick chapter page did not contain __NEXT_DATA__."
            );
        }

        let nextData;

        try {
            nextData =
                JSON.parse(nextDataMatch[1]);
        } catch (error) {
            throw new Error(
                "Could not parse Comick chapter data."
            );
        }

        const pageProps =
            nextData?.props?.pageProps || {};

        const chapterData =
            pageProps.chapter ||
            pageProps.chapterData ||
            pageProps;

        const imageData =
            chapterData?.md_images ||
            pageProps?.md_images ||
            [];

        if (!Array.isArray(imageData) || !imageData.length) {
            throw new Error(
                "Comick did not return manga pages."
            );
        }

        // =====================================================
        // 7. CONVERT IMAGE DATA TO URLS
        // =====================================================

        const pages = imageData
            .map(image => {

                // Some versions return strings.
                if (typeof image === "string") {
                    if (
                        image.startsWith("http://") ||
                        image.startsWith("https://")
                    ) {
                        return image;
                    }

                    return `https://meo.comick.pictures/${image}`;
                }

                if (!image || typeof image !== "object") {
                    return null;
                }

                // Different Comick responses have used
                // different property names.
                const url =
                    image.url ||
                    image.src ||
                    image.image ||
                    image.b2key ||
                    image.path;

                if (!url) {
                    return null;
                }

                if (
                    url.startsWith("http://") ||
                    url.startsWith("https://")
                ) {
                    return url;
                }

                return `https://meo.comick.pictures/${url}`;
            })
            .filter(Boolean);

        if (!pages.length) {
            throw new Error(
                "Comick returned page data, but no usable image URLs."
            );
        }

        // =====================================================
        // 8. RETURN STANDARD FORMAT
        // =====================================================

        return {
            title,
            chapter: String(chap),
            pages
        };
    }
};
