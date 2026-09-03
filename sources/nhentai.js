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


/*
 * ---------------------------------------------------------
 * NORMALIZATION
 * ---------------------------------------------------------
 */

function normalize(text) {
    return String(text || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[\[\](){}]/g, " ")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}


function getWords(text) {
    return normalize(text)
        .split(" ")
        .filter(word => word.length >= 2);
}


/*
 * ---------------------------------------------------------
 * GALLERY ID DETECTION
 * ---------------------------------------------------------
 */

function getGalleryId(value) {
    const text = String(value || "").trim();

    /*
     * https://nhentai.net/g/551096/
     */
    const urlMatch = text.match(
        /nhentai\.net\/g\/(\d+)/i
    );

    if (urlMatch) {
        return urlMatch[1];
    }

    /*
     * 551096
     */
    if (/^\d+$/.test(text)) {
        return text;
    }

    return null;
}


/*
 * ---------------------------------------------------------
 * IMAGE URL
 * ---------------------------------------------------------
 */

function absoluteImage(path) {
    if (!path) return null;

    const value = String(path).trim();

    if (!value) return null;

    if (/^https?:\/\//i.test(value)) {
        return value;
    }

    return `${IMAGE_BASE}/${value.replace(/^\/+/, "")}`;
}


/*
 * ---------------------------------------------------------
 * DIRECT GALLERY API
 * ---------------------------------------------------------
 */

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


/*
 * ---------------------------------------------------------
 * EXTRACT ALL POSSIBLE TITLE VARIANTS
 * ---------------------------------------------------------
 */

function getTitleVariants(result) {

    const titles = [];

    function add(value) {

        if (!value) return;

        if (typeof value === "string") {
            titles.push(value);
            return;
        }

        if (typeof value === "object") {

            for (const key of [
                "english",
                "pretty",
                "japanese",
                "original"
            ]) {

                if (
                    typeof value[key] === "string" &&
                    value[key].trim()
                ) {
                    titles.push(value[key]);
                }
            }
        }
    }

    /*
     * Different nHentai API versions / wrappers
     * expose titles differently.
     */

    add(result?.title);
    add(result?.english);
    add(result?.english_title);
    add(result?.pretty);
    add(result?.japanese);
    add(result?.original_title);

    return [
        ...new Set(
            titles
                .map(normalize)
                .filter(Boolean)
        )
    ];
}


/*
 * ---------------------------------------------------------
 * TITLE MATCH SCORE
 * ---------------------------------------------------------
 */

function scoreResult(result, requestedTitle) {

    const requested =
        normalize(requestedTitle);

    if (!requested) {
        return 0;
    }

    const requestedWords =
        getWords(requested);

    const variants =
        getTitleVariants(result);

    if (!variants.length) {
        return 0;
    }

    let bestScore = 0;

    for (const title of variants) {

        let score = 0;

        /*
         * Exact title match
         */
        if (title === requested) {
            score += 10000;
        }

        /*
         * Requested title completely contained
         */
        if (title.includes(requested)) {
            score += 5000;
        }

        /*
         * Requested title contains the API title
         */
        if (
            requested.includes(title) &&
            title.length >= 5
        ) {
            score += 3500;
        }

        const titleWords =
            new Set(getWords(title));

        let matchedWords = 0;

        for (const word of requestedWords) {

            if (titleWords.has(word)) {
                matchedWords++;
            }
        }

        /*
         * Word overlap
         */
        if (requestedWords.length) {

            const ratio =
                matchedWords /
                requestedWords.length;

            score +=
                Math.round(
                    ratio * 4000
                );
        }

        /*
         * Strong bonus when the important words
         * are all present.
         */
        if (
            requestedWords.length >= 2 &&
            matchedWords === requestedWords.length
        ) {
            score += 3000;
        }

        /*
         * First words often contain the actual title
         * while [Artist] information comes before it.
         */
        const compactTitle =
            title.replace(/\s+/g, "");

        const compactRequested =
            requested.replace(/\s+/g, "");

        if (
            compactTitle === compactRequested
        ) {
            score += 5000;
        }

        bestScore =
            Math.max(
                bestScore,
                score
            );
    }

    return bestScore;
}


/*
 * ---------------------------------------------------------
 * SEARCH ONE PAGE
 * ---------------------------------------------------------
 */

async function searchPage(query, page) {

    try {

        const response =
            await client.get(
                `${API_BASE}/search`,
                {
                    params: {
                        query,
                        page,
                        sort: "popular"
                    }
                }
            );

        const results =
            response.data?.results;

        if (
            !Array.isArray(results)
        ) {
            return [];
        }

        return results;

    } catch (error) {

        /*
         * Don't immediately destroy the entire search
         * because one page failed.
         */

        return [];
    }
}


/*
 * ---------------------------------------------------------
 * SMART TITLE SEARCH
 * ---------------------------------------------------------
 */

async function searchGallery(query) {

    const requested =
        normalize(query);

    if (!requested) {
        return null;
    }

    /*
     * Search the exact query first.
     */
    const queries = [
        query
    ];

    /*
     * Also search the normalized version.
     */
    if (
        normalize(query) !== query
    ) {
        queries.push(
            normalize(query)
        );
    }

    /*
     * For titles containing artist/group prefixes,
     * also search the meaningful words.
     */
    const words =
        getWords(query);

    if (words.length >= 2) {

        const simplified =
            words
                .slice(0, 10)
                .join(" ");

        if (
            !queries.some(
                q =>
                    normalize(q) ===
                    normalize(simplified)
            )
        ) {
            queries.push(simplified);
        }
    }

    const candidates = [];

    /*
     * Search up to 3 pages for each query.
     */
    for (const searchQuery of queries) {

        for (let page = 1; page <= 3; page++) {

            const results =
                await searchPage(
                    searchQuery,
                    page
                );

            for (const result of results) {

                if (!result?.id) {
                    continue;
                }

                const score =
                    scoreResult(
                        result,
                        query
                    );

                candidates.push({
                    result,
                    score
                });
            }
        }
    }

    if (!candidates.length) {
        return null;
    }

    /*
     * Remove duplicate galleries.
     */
    const unique =
        new Map();

    for (const candidate of candidates) {

        const id =
            String(
                candidate.result.id
            );

        const existing =
            unique.get(id);

        if (
            !existing ||
            candidate.score >
                existing.score
        ) {
            unique.set(
                id,
                candidate
            );
        }
    }

    const ranked =
        [...unique.values()]
            .sort(
                (a, b) =>
                    b.score - a.score
            );

    const best =
        ranked[0];

    /*
     * IMPORTANT:
     *
     * Never blindly accept a random search result.
     */

    if (
        !best ||
        best.score < 2500
    ) {
        return null;
    }

    /*
     * If the second result is nearly as good,
     * don't make a dangerous guess.
     */
    const second =
        ranked[1];

    if (
        second &&
        second.score >=
            best.score * 0.92 &&
        best.score < 7000
    ) {
        return null;
    }

    return best.result;
}


/*
 * ---------------------------------------------------------
 * MAIN SOURCE
 * ---------------------------------------------------------
 */

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
         * =================================================
         * DIRECT GALLERY ID
         * =================================================
         *
         * -manga 551096 1
         *
         * MUST ALWAYS use the exact gallery.
         */

        let galleryId =
            getGalleryId(titleText);


        /*
         * If the ID was accidentally supplied
         * as the chapter value.
         */
        if (
            !galleryId &&
            /^\d+$/.test(chapterText)
        ) {

            /*
             * Only use this as an ID when title
             * itself is empty-like.
             *
             * Normally manga.js sends the actual
             * title here, so we don't blindly replace it.
             */

            if (
                !titleText ||
                titleText === chapterText
            ) {
                galleryId =
                    chapterText;
            }
        }


        let gallery;


        /*
         * =================================================
         * DIRECT LOOKUP
         * =================================================
         */

        if (galleryId) {

            gallery =
                await getGallery(
                    galleryId
                );

        }


        /*
         * =================================================
         * TITLE SEARCH
         * =================================================
         */

        else {

            const result =
                await searchGallery(
                    titleText
                );

            if (!result?.id) {

                throw new Error(
                    `No reliable nHentai gallery found for "${titleText}".`
                );
            }

            galleryId =
                String(
                    result.id
                );

            gallery =
                await getGallery(
                    galleryId
                );
        }


        /*
         * =================================================
         * PAGE DATA
         * =================================================
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
                .sort(
                    (a, b) =>
                        Number(a?.number || 0) -
                        Number(b?.number || 0)
                )
                .map(page =>
                    absoluteImage(
                        page?.path
                    )
                )
                .filter(Boolean);


        if (!pages.length) {

            throw new Error(
                `Gallery ${gallery.id} returned page metadata but no usable image paths.`
            );
        }


        /*
         * =================================================
         * FINAL RESPONSE
         * =================================================
         */

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
