const express = require("express");

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

app.get("/api/manga", (req, res) => {
    res.json({
        success: true,
        message: "Manga endpoint is working.",
        query: {
            title: req.query.title || null,
            chapter: req.query.chapter || null
        }
    });
});

app.listen(PORT, () => {
    console.log(`Hahari Manga API running on port ${PORT}`);
});
