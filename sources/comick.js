const axios = require("axios");

const API = "https://api.comick.io";
const WEB = "https://comick.io";
const IMAGE_HOST = "https://meo.comick.pictures";

const headers = {
    Accept: "application/json",
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/131.0.0.0 Safari/537.36",
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

async function get(url, config = {}) {
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
        // 1. SEARCH
        // =====================================================

        const searchResponse = await get(
            `${API}/v1.0/search`,
            {
                params: {
                    q: mangaName
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
        // 2. SELECT MANGA
        // =====================================================

        const normalizedQuery =
            normalize(mangaName);

        let manga = results.find(item => {

            const possibleTitles = [
                item.title,
                item.name,
                item.comic?.title
            ];

            return possibleTitles.some(title =>
                normalize(title) === normalizedQuery
            );
        });

        if (!manga) {
            manga = results[0];
        }

        const hid =
            manga.hid ||
            manga.comic?.hid ||
            manga.id;

        const slug =
            manga.slug ||
            manga.comic?.slug;

        const title =
            manga.title ||
            manga.name ||
            manga.comic?.title ||
            mangaName;

        if (!hid) {
            throw new Error(
                "Comick search did not return a manga ID."
            );
        }

        if (!slug) {
            throw new Error(
                "Comick search did not return a manga slug."
            );
        }

        // =====================================================
        // 3. GET CHAPTER LIST
        // =====================================================

        /*
         * Current Comick endpoint:
         *
         * /comic/{hid}/chapters
         *
         * We request English chapters.
         *
         * `chap` is deliberately NOT sent here.
         * We fetch the chapter list and select the
         * requested chapter locally.
         */

        const chapterResponse = await get(
            `${API}/comic/${encodeURIComponent(hid)}/chapters`,
            {
                params: {
                    lang: "en"
                }
            }
        );

        const chapters =
            chapterResponse.data?.chapters ||
            [];

        if (
            !Array.isArray(chapters) ||
            !chapters.length
        ) {
            throw new Error(
                `No English chapters found for "${title}".`
            );
        }

        // =====================================================
        // 4. FIND REQUESTED CHAPTER
        // =====================================================

        let chapter = chapters.find(ch =>
            chapterMatches(
                ch.chap,
                chapterNumber
            )
        );

        /*
         * Some Comick chapter lists are paginated.
         *
         * If the requested chapter isn't in the first
         * response, continue through additional pages.
         */

        if (!chapter) {

            let page = 2;

            const MAX_PAGES = 30;

            while (
                page <= MAX_PAGES &&
                !chapter
            ) {

                const response = await get(
                    `${API}/comic/${encodeURIComponent(hid)}/chapters`,
                    {
                        params: {
                            lang: "en",
                            page
                        }
                    }
                );

                const more =
                    response.data?.chapters ||
                    [];

                if (
                    !Array.isArray(more) ||
                    !more.length
                ) {
                    break;
                }

                chapter = more.find(ch =>
                    chapterMatches(
                        ch.chap,
                        chapterNumber
                    )
                );

                if (more.length < 100) {
                    break;
                }

                page++;
            }
        }

        if (!chapter) {
            throw new Error(
                `Chapter ${chapterNumber} was not found on Comick.`
            );
        }

        // =====================================================
        // 5. CHAPTER INFORMATION
        // =====================================================

        const chapterHid =
            chapter.hid ||
            chapter.chapter_hid ||
            chapter.id;

        const chap =
            chapter.chap ||
            String(chapterNumber);

        const lang =
            chapter.lang ||
            "en";

        if (!chapterHid) {
            throw new Error(
                "Comick chapter did not return a chapter ID."
            );
        }

        // =====================================================
        // 6. BUILD CHAPTER PAGE
        // =====================================================

        const chapterURL =
            `${WEB}/comic/${slug}/` +
            `${chapterHid}-chapter-${chap}-${lang}`;

        const pageResponse =
            await axios.get(
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

        if (
            !html ||
            typeof html !== "string"
        ) {
            throw new Error(
                "Comick returned an invalid chapter page."
            );
        }

        // =====================================================
        // 7. EXTRACT NEXT.JS DATA
        // =====================================================

        const match =
            html.match(
                /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
            );

        if (!match) {
            throw new Error(
                "Comick chapter page did not contain __NEXT_DATA__."
            );
        }

        let nextData;

        try {
            nextData =
                JSON.parse(match[1]);
        } catch {
            throw new Error(
                "Could not parse Comick chapter data."
            );
        }

        const pageProps =
            nextData?.props?.pageProps ||
            {};

        const chapterData =
            pageProps.chapter ||
            pageProps.chapterData ||
            {};

        const imageData =
            chapterData.md_images ||
            pageProps.md_images ||
            [];

        if (
            !Array.isArray(imageData) ||
            !imageData.length
        ) {
            throw new Error(
                "Comick did not return manga pages."
            );
        }

        // =====================================================
        // 8. BUILD IMAGE URLS
        // =====================================================

        const pages = imageData
            .map(image => {

                if (
                    typeof image === "string"
                ) {

                    if (
                        image.startsWith("http://") ||
                        image.startsWith("https://")
                    ) {
                        return image;
                    }

                    return `${IMAGE_HOST}/${image}`;
                }

                if (
                    !image ||
                    typeof image !== "object"
                ) {
                    return null;
                }

                const value =
                    image.b2key ||
                    image.url ||
                    image.src ||
                    image.image ||
                    image.path;

                if (!value) {
                    return null;
                }

                if (
                    value.startsWith("http://") ||
                    value.startsWith("https://")
                ) {
                    return value;
                }

                return `${IMAGE_HOST}/${value}`;
            })
            .filter(Boolean);

        if (!pages.length) {
            throw new Error(
                "Comick returned no usable image URLs."
            );
        }

        // =====================================================
        // 9. STANDARD API RESPONSE
        // =====================================================

        return {
            title,
            chapter: String(chap),
            pages
        };
    }
};
