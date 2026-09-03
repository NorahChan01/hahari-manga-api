const axios = require("axios");
const https = require("https");

const BASE_URL = "https://mangataro.org";

const agent = new https.Agent({
    rejectUnauthorized: false
});

const client = axios.create({
    httpsAgent: agent,
    timeout: 30000,
    maxRedirects: 5,
    headers: {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/139.0.0.0 Safari/537.36",
        "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9," +
            "image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": BASE_URL + "/"
    }
});

function normalizeTitle(title) {
    return String(title || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function slugify(title) {
    return normalizeTitle(title)
        .replace(/\s+/g, "-");
}

function cleanUrl(url) {
    if (!url) return null;

    url = String(url)
        .replace(/&amp;/g, "&")
        .replace(/\\\//g, "/")
        .trim();

    if (url.startsWith("//")) {
        url = "https:" + url;
    }

    try {
        return new URL(url, BASE_URL).href;
    } catch {
        return null;
    }
}

function extractImages(html) {
    const images = new Set();

    const add = (url) => {
        url = cleanUrl(url);

        if (!url) return;

        if (
            !/\.(jpg|jpeg|png|webp|gif)(?:[?#].*)?$/i.test(
                url
            )
        ) {
            return;
        }

        const lower = url.toLowerCase();

        if (
            lower.includes("logo") ||
            lower.includes("avatar") ||
            lower.includes("icon")
        ) {
            return;
        }

        images.add(url);
    };

    let match;

    const imgRegex =
        /<img\b[^>]*(?:src|data-src|data-original|data-lazy-src)\s*=\s*["']([^"']+)["'][^>]*>/gi;

    while ((match = imgRegex.exec(html)) !== null) {
        add(match[1]);
    }

    const srcsetRegex =
        /(?:srcset|data-srcset)\s*=\s*["']([^"']+)["']/gi;

    while ((match = srcsetRegex.exec(html)) !== null) {
        for (const item of match[1].split(",")) {
            add(item.trim().split(/\s+/)[0]);
        }
    }

    const absoluteRegex =
        /https?:\/\/[^"'\\\s<>]+?\.(?:jpg|jpeg|png|webp|gif)(?:\?[^"'\\\s<>]*)?/gi;

    while ((match = absoluteRegex.exec(html)) !== null) {
        add(match[0]);
    }

    return Array.from(images);
}

function extractChapterLinks(html, chapter) {
    const links = [];

    const target = String(chapter)
        .replace(/^chapter\s*/i, "")
        .trim();

    const regex =
        /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;

    while ((match = regex.exec(html)) !== null) {
        const href = cleanUrl(match[1]);

        if (!href) continue;

        if (!href.includes("/read/")) continue;

        const text = match[2]
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        const combined =
            `${href} ${text}`;

        const chapterRegex = new RegExp(
            `(?:chapter|ch)[\\s-]*${target}(?:\\D|$)`,
            "i"
        );

        if (chapterRegex.test(combined)) {
            if (!links.includes(href)) {
                links.push(href);
            }
        }
    }

    return links;
}

async function getChapter(title, chapter) {
    if (!title) {
        throw new Error("Manga title is required.");
    }

    if (!chapter) {
        throw new Error("Chapter number is required.");
    }

    const chapterNumber = String(chapter)
        .replace(/^chapter\s*/i, "")
        .trim();

    const slug = slugify(title);

    const mangaUrls = [
        `${BASE_URL}/manga/${slug}`,
        `${BASE_URL}/manga/${slug}/`
    ];

    const tried = new Set();

    for (const mangaUrl of mangaUrls) {
        if (tried.has(mangaUrl)) continue;

        tried.add(mangaUrl);

        try {
            const response = await client.get(mangaUrl);

            if (response.status !== 200) {
                continue;
            }

            const html = response.data;

            /*
             * Don't treat login/access pages as successful.
             */
            if (
                /login required/i.test(html) &&
                /access restricted/i.test(html)
            ) {
                continue;
            }

            const chapterLinks =
                extractChapterLinks(
                    html,
                    chapterNumber
                );

            for (const chapterUrl of chapterLinks) {
                if (tried.has(chapterUrl)) continue;

                tried.add(chapterUrl);

                try {
                    const chapterResponse =
                        await client.get(chapterUrl);

                    if (
                        chapterResponse.status !== 200
                    ) {
                        continue;
                    }

                    const chapterHtml =
                        chapterResponse.data;

                    if (
                        /login required/i.test(
                            chapterHtml
                        ) &&
                        /access restricted/i.test(
                            chapterHtml
                        )
                    ) {
                        continue;
                    }

                    const pages =
                        extractImages(chapterHtml);

                    if (pages.length > 0) {
                        return {
                            title,
                            chapter: chapterNumber,
                            source: "MangaTaro",
                            pages
                        };
                    }
                } catch {
                    // Continue.
                }
            }
        } catch {
            // Continue.
        }
    }

    throw new Error(
        `MangaTaro requires access/login or no public pages were found for "${title}" chapter ${chapterNumber}.`
    );
}

module.exports = {
    name: "MangaTaro",
    getChapter
};
