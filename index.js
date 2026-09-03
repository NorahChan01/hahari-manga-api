const express = require("express");
const crypto = require("crypto");
const sources = require("./sources");

const app = express();

const PORT = process.env.PORT || 3000;

/*
 * Temporary MangaDenizi image cache.
 *
 * token -> {
 *   image_url,
 *   scramble,
 *   createdAt
 * }
 */
const imageCache = new Map();

const IMAGE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/*
 * Clean expired cached images periodically.
 */
setInterval(() => {
    const now = Date.now();

    for (const [token, data] of imageCache.entries()) {
        if (
            !data ||
            now - data.createdAt > IMAGE_CACHE_TTL
        ) {
            imageCache.delete(token);
        }
    }
}, 60 * 1000);

/*
 * Create a temporary image token.
 */
function createImageToken(image_url, scramble) {
    const token = crypto
        .randomBytes(24)
        .toString("hex");

    imageCache.set(token, {
        image_url,
        scramble: scramble || {},
        createdAt: Date.now()
    });

    return token;
}

/*
 * Normalize manga titles for comparison.
 *
 * Examples:
 *
 * "Naruto"
 * "NARUTO!"
 * "naruto"
 *
 * all become:
 *
 * "naruto"
 */
function normalizeTitle(text) {
    return String(text || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/&/g, " and ")
        .replace(/['’`]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/*
 * Remove common title prefixes/suffixes that sources
 * sometimes add.
 */
function cleanTitle(text) {
    return normalizeTitle(text)
        .replace(
            /^(the|a|an)\s+/,
            ""
        )
        .replace(
            /\s+(manga|manhwa|manhua|webtoon)$/i,
            ""
        )
        .trim();
}

/*
 * Calculate how closely a source title matches the
 * title requested by the user.
 *
 * Score:
 *
 * 100 = exact normalized match
 *  95 = exact after removing common prefixes
 *  90 = one contains the other
 *  80+ = strong word overlap
 *  lower = weak/unsafe match
 */
function titleMatchScore(requested, returned) {
    const wanted =
        normalizeTitle(requested);

    const actual =
        normalizeTitle(returned);

    if (!wanted || !actual) {
        return 0;
    }

    /*
     * Exact match.
     */
    if (wanted === actual) {
        return 100;
    }

    /*
     * Match after removing harmless title words.
     */
    const cleanWanted =
        cleanTitle(requested);

    const cleanActual =
        cleanTitle(returned);

    if (
        cleanWanted &&
        cleanActual &&
        cleanWanted === cleanActual
    ) {
        return 95;
    }

    /*
     * Prevent tiny queries from matching huge unrelated
     * titles.
     */
    if (
        wanted.length < 4 ||
        actual.length < 4
    ) {
        return 0;
    }

    /*
     * Exact containment.
     *
     * Example:
     *
     * requested:
     * "naruto"
     *
     * returned:
     * "naruto shippuden"
     *
     * This is allowed, but is weaker than exact.
     */
    if (
        actual.includes(wanted) ||
        wanted.includes(actual)
    ) {
        const shorter =
            Math.min(
                wanted.length,
                actual.length
            );

        const longer =
            Math.max(
                wanted.length,
                actual.length
            );

        /*
         * Don't accept extremely unbalanced matches.
         */
        if (
            shorter / longer >= 0.45
        ) {
            return 90;
        }
    }

    /*
     * Word-overlap matching.
     */
    const wantedWords =
        wanted
            .split(" ")
            .filter(word => word.length >= 2);

    const actualWords =
        actual
            .split(" ")
            .filter(word => word.length >= 2);

    if (
        !wantedWords.length ||
        !actualWords.length
    ) {
        return 0;
    }

    let matched = 0;

    for (const wantedWord of wantedWords) {

        if (
            actualWords.includes(
                wantedWord
            )
        ) {
            matched++;
            continue;
        }

        /*
         * Allow a word to be contained in another word
         * only when the word is reasonably long.
         */
        if (
            wantedWord.length >= 5 &&
            actualWords.some(
                actualWord =>
                    actualWord.includes(wantedWord) ||
                    wantedWord.includes(actualWord)
            )
        ) {
            matched++;
        }
    }

    const coverage =
        matched / wantedWords.length;

    /*
     * Strong match.
     */
    if (
        coverage >= 0.9
    ) {
        return 85;
    }

    if (
        coverage >= 0.75
    ) {
        return 75;
    }

    if (
        coverage >= 0.5 &&
        wantedWords.length >= 2
    ) {
        return 60;
    }

    /*
     * One-word titles need to be strict.
     *
     * This prevents:
     *
     * "naruto"
     *
     * from accidentally matching something unrelated.
     */
    if (
        wantedWords.length === 1
    ) {
        return 0;
    }

    return 0;
}

/*
 * Determine whether a source result is actually
 * relevant to the requested manga.
 */
function isAcceptableMatch(requestedTitle, result) {
    if (
        !result ||
        !result.title
    ) {
        return false;
    }

    const score =
        titleMatchScore(
            requestedTitle,
            result.title
        );

    return score >= 75;
}

/*
 * Prepare MangaDenizi pages.
 *
 * MangaDenizi returns objects:
 *
 * {
 *   image_url,
 *   scramble
 * }
 *
 * Other sources return normal URL strings.
 */
function processResultPages(
    source,
    result,
    req
) {
    let pages = result.pages;

    if (
        source.name === "MangaDenizi" &&
        typeof source.processImage === "function"
    ) {

        pages =
            result.pages.map(page => {

                const token =
                    createImageToken(
                        page.image_url,
                        page.scramble
                    );

                return (
                    `/api/manga/image/${token}`
                );
            });

        /*
         * Convert relative URLs into absolute URLs.
         */
        pages =
            pages.map(page => {
                return (
                    `${req.protocol}://${req.get("host")}${page}`
                );
            });

        console.log(
            `[MangaDenizi] Created ${pages.length} image tokens.`
        );
    }

    return pages;
}

/*
 * Root.
 */
app.get("/", (req, res) => {
    res.json({
        success: true,
        name: "Hahari Manga API",
        version: "1.0.0",
        status: "online"
    });
});

/*
 * Manga endpoint.
 */
app.get(
    "/api/manga",
    async (req, res) => {

        const mangaName =
            String(
                req.query.title || ""
            ).trim();

        const chapterNumber =
            String(
                req.query.chapter || ""
            ).trim();

        if (
            !mangaName ||
            !chapterNumber
        ) {
            return res.status(400).json({
                success: false,
                error:
                    "title and chapter are required.",
                example:
                    "/api/manga?title=naruto&chapter=11"
            });
        }

        const errors = [];

        /*
         * We query every source instead of immediately
         * returning the first source that has pages.
         *
         * This is the important fix.
         */
        const results =
            await Promise.all(
                sources.map(
                    async source => {

                        try {

                            console.log(
                                `[MANGA] Trying ${source.name}: ` +
                                `${mangaName} chapter ${chapterNumber}`
                            );

                            const result =
                                await source.getChapter(
                                    mangaName,
                                    chapterNumber
                                );

                            if (
                                result &&
                                Array.isArray(
                                    result.pages
                                ) &&
                                result.pages.length
                            ) {

                                const score =
                                    titleMatchScore(
                                        mangaName,
                                        result.title
                                    );

                                console.log(
                                    `[MANGA] ${source.name} returned ` +
                                    `"${result.title}" ` +
                                    `(match score: ${score})`
                                );

                                return {
                                    source,
                                    result,
                                    score
                                };
                            }

                            return {
                                source,
                                result: null,
                                score: 0,
                                error:
                                    "Source returned no pages."
                            };

                        } catch (error) {

                            console.error(
                                `[${source.name}]`,
                                error.message
                            );

                            return {
                                source,
                                result: null,
                                score: 0,
                                error:
                                    error.message
                            };
                        }
                    }
                )
            );

        /*
         * Store source errors for the final failure response.
         */
        for (const item of results) {

            if (
                item.error
            ) {
                errors.push({
                    source:
                        item.source.name,
                    error:
                        item.error
                });
            }
        }

        /*
         * Keep only results that have actual pages.
         */
        const validResults =
            results.filter(
                item =>
                    item.result &&
                    Array.isArray(
                        item.result.pages
                    ) &&
                    item.result.pages.length
            );

        /*
         * IMPORTANT:
         *
         * Reject unrelated results.
         *
         * Example:
         *
         * Requested:
         * Naruto
         *
         * Asura:
         * 7.1 Limitless Predation
         *
         * score = 0
         *
         * Therefore it is rejected.
         */
        const acceptableResults =
            validResults.filter(
                item =>
                    isAcceptableMatch(
                        mangaName,
                        item.result
                    )
            );

        /*
         * Sort by title relevance first.
         *
         * If two sources both have Naruto,
         * the source returning the exact title wins.
         *
         * If the scores are identical, preserve the
         * original source order.
         */
        acceptableResults.sort(
            (a, b) =>
                b.score - a.score
        );

        /*
         * If there is a strong match, use it.
         */
        if (
            acceptableResults.length
        ) {

            const selected =
                acceptableResults[0];

            const source =
                selected.source;

            const result =
                selected.result;

            console.log(
                `[MANGA] Selected ${source.name}: ` +
                `"${result.title}" ` +
                `(score: ${selected.score})`
            );

            const pages =
                processResultPages(
                    source,
                    result,
                    req
                );

            return res.json({
                success: true,
                title:
                    result.title,
                chapter:
                    result.chapter,
                source:
                    result.source ||
                    source.name,
                pages
            });
        }

        /*
         * No acceptable title match.
         */
        console.log(
            `[MANGA] No acceptable title match for "${mangaName}".`
        );

        /*
         * Add useful information about results that
         * were rejected because their titles did not match.
         */
        for (const item of validResults) {

            const score =
                titleMatchScore(
                    mangaName,
                    item.result.title
                );

            if (
                score < 75
            ) {

                errors.push({
                    source:
                        item.source.name,

                    error:
                        `Returned "${item.result.title}", ` +
                        `but it did not sufficiently match ` +
                        `"${mangaName}" ` +
                        `(match score: ${score}).`
                });
            }
        }

        return res.status(404).json({
            success: false,
            error:
                "Chapter not found on available sources.",
            title:
                mangaName,
            chapter:
                chapterNumber,
            sourcesTried:
                errors
        });
    }
);

/*
 * MangaDenizi image proxy.
 *
 * manga.js requests:
 *
 * /api/manga/image/{token}
 *
 * The server then:
 *
 * 1. Finds the cached MangaDenizi image.
 * 2. Downloads it.
 * 3. Applies XOR or tiled-v1 descrambling.
 * 4. Sends the final image to the bot.
 */
app.get(
    "/api/manga/image/:token",
    async (req, res) => {

        const token =
            String(
                req.params.token || ""
            ).trim();

        if (!token) {
            return res.status(400).send(
                "Missing image token."
            );
        }

        const cached =
            imageCache.get(token);

        if (!cached) {
            return res.status(404).send(
                "Image token expired or not found."
            );
        }

        /*
         * Refresh TTL when image is requested.
         */
        cached.createdAt =
            Date.now();

        try {

            /*
             * Find MangaDenizi source.
             */
            const MangaDenizi =
                sources.find(
                    source =>
                        source.name ===
                        "MangaDenizi"
                );

            if (
                !MangaDenizi ||
                typeof MangaDenizi.processImage !==
                    "function"
            ) {
                return res.status(500).send(
                    "MangaDenizi image processor is unavailable."
                );
            }

            console.log(
                `[MangaDenizi] Processing image ${token}`
            );

            /*
             * sharp is loaded by mangadenizi.js itself
             * through its processor.
             */
            const processed =
                await MangaDenizi.processImage(
                    cached.image_url,
                    cached.scramble
                );

            /*
             * Tell browser/bot what we're returning.
             */
            res.setHeader(
                "Content-Type",
                processed.contentType ||
                "image/png"
            );

            res.setHeader(
                "Cache-Control",
                "public, max-age=300"
            );

            return res.send(
                processed.buffer
            );

        } catch (error) {

            console.error(
                "[MangaDenizi IMAGE ERROR]",
                error.message
            );

            return res.status(500).send(
                `Image processing failed: ${error.message}`
            );
        }
    }
);

/*
 * Error handler.
 */
app.use(
    (error, req, res, next) => {

        console.error(
            "[API ERROR]",
            error
        );

        if (res.headersSent) {
            return next(error);
        }

        return res.status(500).json({
            success: false,
            error:
                "Internal server error."
        });
    }
);

app.listen(
    PORT,
    () => {
        console.log(
            `Hahari Manga API running on port ${PORT}`
        );
    }
);
