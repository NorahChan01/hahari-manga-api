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
app.get("/api/manga", async (req, res) => {

    const mangaName = String(
        req.query.title || ""
    ).trim();

    const chapterNumber = String(
        req.query.chapter || ""
    ).trim();

    if (!mangaName || !chapterNumber) {
        return res.status(400).json({
            success: false,
            error: "title and chapter are required.",
            example:
                "/api/manga?title=naruto&chapter=11"
        });
    }

    const errors = [];

    for (const source of sources) {

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
                Array.isArray(result.pages) &&
                result.pages.length
            ) {

                /*
                 * MangaDenizi returns page objects:
                 *
                 * {
                 *   image_url: "...",
                 *   scramble: {...}
                 * }
                 *
                 * Other sources return normal strings.
                 *
                 * We convert MangaDenizi objects into temporary
                 * API image URLs so manga.js can continue using
                 * normal page URLs.
                 */

                let pages = result.pages;

                if (
                    source.name === "MangaDenizi" &&
                    typeof source.processImage === "function"
                ) {

                    pages = result.pages.map(page => {

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
                    pages = pages.map(page => {
                        return `${req.protocol}://${req.get("host")}${page}`;
                    });

                    console.log(
                        `[MangaDenizi] Created ${pages.length} image tokens.`
                    );
                }

                return res.json({
                    success: true,
                    title: result.title,
                    chapter: result.chapter,
                    source:
                        result.source ||
                        source.name,
                    pages
                });
            }

            errors.push({
                source: source.name,
                error: "Source returned no pages."
            });

        } catch (error) {

            console.error(
                `[${source.name}]`,
                error.message
            );

            errors.push({
                source: source.name,
                error: error.message
            });
        }
    }

    return res.status(404).json({
        success: false,
        error:
            "Chapter not found on available sources.",
        title: mangaName,
        chapter: chapterNumber,
        sourcesTried: errors
    });
});

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

        const token = String(
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
        cached.createdAt = Date.now();

        try {

            /*
             * Find MangaDenizi source.
             */
            const MangaDenizi =
                sources.find(
                    source =>
                        source.name === "MangaDenizi"
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
app.use((error, req, res, next) => {

    console.error(
        "[API ERROR]",
        error
    );

    if (res.headersSent) {
        return next(error);
    }

    return res.status(500).json({
        success: false,
        error: "Internal server error."
    });
});

app.listen(PORT, () => {
    console.log(
        `Hahari Manga API running on port ${PORT}`
    );
});
