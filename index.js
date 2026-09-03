const express = require("express");
const mangaSources = require("./sources");

const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/", (req, res) => {
    res.json({
        success: true,
        name: "Hahari Manga API",
        version: "2.0.0",
        status: "online",
        sources: mangaSources.map(source => source.name)
    });
});

app.get("/api/manga", async (req, res) => {

    const title = String(req.query.title || "").trim();
    const chapter = String(req.query.chapter || "").trim();

    if (!title) {
        return res.status(400).json({
            success: false,
            error: "Missing title",
            usage: "/api/manga?title=100%20girlfriends&chapter=214"
        });
    }

    if (!chapter) {
        return res.status(400).json({
            success: false,
            error: "Missing chapter",
            usage: "/api/manga?title=100%20girlfriends&chapter=214"
        });
    }

    console.log(
        `[MANGA] Searching "${title}" chapter ${chapter}`
    );

    const errors = [];

    for (const source of mangaSources) {

        try {

            console.log(
                `[MANGA] Trying ${source.name}...`
            );

            const result = await source.getChapter(
                title,
                chapter
            );

            if (
                result &&
                Array.isArray(result.pages) &&
                result.pages.length > 0
            ) {

                console.log(
                    `[MANGA] ${source.name} found ${result.pages.length} pages`
                );

                return res.json({
                    success: true,
                    title: result.title || title,
                    chapter: result.chapter || chapter,
                    source: source.name,
                    pages: result.pages
                });
            }

            errors.push({
                source: source.name,
                error: "Chapter not found"
            });

        } catch (error) {

            console.error(
                `[MANGA] ${source.name} failed:`,
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
        error: "Chapter not found",
        title,
        chapter,
        sourcesTried: errors
    });
});

app.get("/api/manga/health", (req, res) => {
    res.json({
        success: true,
        status: "healthy",
        sources: mangaSources.map(source => source.name)
    });
});

app.listen(PORT, () => {
    console.log(
        `Hahari Manga API running on port ${PORT}`
    );
});
