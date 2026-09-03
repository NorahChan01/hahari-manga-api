const express = require("express");
const sources = require("./sources");

const app = express();

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
    res.json({
        success: true,
        name: "Hahari Manga API",
        version: "1.0.0",
        status: "online"
    });
});

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

                return res.json({
    success: true,
    title: result.title,
    chapter: result.chapter,
    source: result.source || source.name,
    pages: result.pages
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
        error: "Chapter not found on available sources.",
        title: mangaName,
        chapter: chapterNumber,
        sourcesTried: errors
    });
});

app.listen(PORT, () => {
    console.log(
        `Hahari Manga API running on port ${PORT}`
    );
});
