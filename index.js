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

const IMAGE_CACHE_TTL = 10 * 60 * 1000;

/*
 * Clean expired cached images.
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
 * Create temporary image token.
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
 * Normalize title.
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
 * Clean common title prefixes/suffixes.
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
 * Check if request is a numeric ID.
 *
 * This is important for nHentai.
 *
 * Example:
 *
 * -manga 535539 2
 *
 * "535539" is not a manga title.
 * It is a gallery ID.
 */
function isNumericId(text) {
    return /^\d+$/.test(
        String(text || "").trim()
    );
}

/*
 * Calculate title similarity.
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
     * Exact title.
     */
    if (wanted === actual) {
        return 100;
    }

    /*
     * Exact match after removing common words.
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
     * Very short titles are kept strict.
     */
    if (
        wanted.length < 4 ||
        actual.length < 4
    ) {
        return 0;
    }

    /*
     * Containment matching.
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

        if (
            shorter / longer >= 0.45
        ) {
            return 90;
        }
    }

    /*
     * Word overlap.
     */
    const wantedWords =
        wanted
            .split(" ")
            .filter(
                word =>
                    word.length >= 2
            );

    const actualWords =
        actual
            .split(" ")
            .filter(
                word =>
                    word.length >= 2
            );

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

        if (
            wantedWord.length >= 5 &&
            actualWords.some(
                actualWord =>
                    actualWord.includes(
                        wantedWord
                    ) ||
                    wantedWord.includes(
                        actualWord
                    )
            )
        ) {
            matched++;
        }
    }

    const coverage =
        matched / wantedWords.length;

    if (coverage >= 0.9) {
        return 85;
    }

    if (coverage >= 0.75) {
        return 75;
    }

    if (
        coverage >= 0.5 &&
        wantedWords.length >= 2
    ) {
        return 60;
    }

    /*
     * Single-word titles must be strict.
     */
    if (
        wantedWords.length === 1
    ) {
        return 0;
    }

    return 0;
}

/*
 * Determine whether a result is acceptable.
 *
 * Numeric IDs are automatically accepted.
 */
function isAcceptableMatch(
    requestedTitle,
    result
) {
    if (!result) {
        return false;
    }

    /*
     * Numeric requests are direct IDs.
     *
     * Example:
     * 535539
     */
    if (
        isNumericId(
            requestedTitle
        )
    ) {
        return true;
    }

    if (!result.title) {
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
 * Process source pages.
 */
function processResultPages(
    source,
    result,
    req
) {
    let pages =
        result.pages;

    /*
     * MangaDenizi returns:
     *
     * {
     *   image_url,
     *   scramble
     * }
     */
    if (
        source.name === "MangaDenizi" &&
        typeof source.processImage ===
            "function"
    ) {

        pages =
            result.pages.map(
                page => {

                    const token =
                        createImageToken(
                            page.image_url,
                            page.scramble
                        );

                    return (
                        `/api/manga/image/${token}`
                    );
                }
            );

        /*
         * Convert relative URLs to absolute URLs.
         */
        pages =
            pages.map(
                page =>
                    `${req.protocol}://${req.get("host")}${page}`
            );

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
         * Determine whether this is a direct numeric ID.
         */
        const numericRequest =
            isNumericId(
                mangaName
            );

        /*
         * Ask every source.
         *
         * We don't immediately accept the first result.
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

                                /*
                                 * Numeric ID:
                                 *
                                 * Do NOT compare the ID against
                                 * the returned gallery title.
                                 */
                                const score =
                                    numericRequest
                                        ? 100
                                        : titleMatchScore(
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
         * Collect source errors.
         */
        for (
            const item of results
        ) {

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
         * Only sources that returned pages.
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
         * Find acceptable results.
         *
         * Numeric IDs automatically pass.
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
         * Highest match wins.
         */
        acceptableResults.sort(
            (a, b) =>
                b.score - a.score
        );

        /*
         * Select the best result.
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
         * No acceptable result.
         */
        console.log(
            `[MANGA] No acceptable title match for "${mangaName}".`
        );

        /*
         * Add rejected results to error information.
         */
        for (
            const item of validResults
        ) {

            /*
             * Numeric requests should never reach here,
             * but keep this safe.
             */
            if (
                numericRequest
            ) {
                continue;
            }

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
         * Refresh TTL.
         */
        cached.createdAt =
            Date.now();

        try {

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

            const processed =
                await MangaDenizi.processImage(
                    cached.image_url,
                    cached.scramble
                );

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

        if (
            res.headersSent
        ) {
            return next(error);
        }

        return res.status(500).json({
            success: false,
            error:
                "Internal server error."
        });

    }
);

/*
 * Start server.
 */
app.listen(
    PORT,
    () => {

        console.log(
            `Hahari Manga API running on port ${PORT}`
        );

    }
);
