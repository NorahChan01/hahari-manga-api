const axios = require("axios");

const BASE_URL = "https://asurascans.com";

const http = axios.create({
    baseURL: BASE_URL,
    timeout: 30000,
    headers: {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
        "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
    }
});

function normalize(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/['’]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function similarity(a, b) {
    const aa = normalize(a);
    const bb = normalize(b);

    if (!aa || !bb) return 0;
    if (aa === bb) return 100;
    if (aa.includes(bb) || bb.includes(aa)) return 90;

    const aWords = new Set(aa.split(/\s+/));
    const bWords = new Set(bb.split(/\s+/));

    let common = 0;

    for (const word of aWords) {
        if (bWords.has(word)) common++;
    }

    return (
        (common / Math.max(aWords.size, bWords.size)) * 100
    );
}

function extractLinks(html) {
    const results = [];

    const regex =
        /href=["'](\/comics\/[^"'?#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;

    while ((match = regex.exec(html))) {
        const url = match[1];
        const text = match[2]
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        results.push({
            url: new URL(url, BASE_URL).href,
            text
        });
    }

    return results;
}

function extractChapterLinks(html) {
    const results = [];

    const regex =
        /href=["']([^"']+)["'][^>]*>([\s\S]*?Chapter[\s\S]*?)<\/a>/gi;

    let match;

    while ((match = regex.exec(html))) {
        const url = match[1];
        const text = match[2]
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        if (
            url.includes("/chapter/") ||
            url.includes("/comics/")
        ) {
            results.push({
                url: new URL(url, BASE_URL).href,
                text
            });
        }
    }

    return results;
}

function extractImageUrls(html) {
    const urls = new Set();

    // Normal image URLs
    const imageRegex =
        /https?:\/\/[^"'\\\s<>]+?\.(?:jpg|jpeg|png|webp)(?:\?[^"'\\\s<>]*)?/gi;

    let match;

    while ((match = imageRegex.exec(html))) {
        urls.add(
            match[0]
                .replace(/\\u0026/g, "&")
                .replace(/\\\//g, "/")
        );
    }

    // JSON escaped URLs
    const escapedRegex =
        /https?:\\\/\\\/[^"'\\\s<>]+?\.(?:jpg|jpeg|png|webp)(?:\\?[^"'\\\s<>]*)?/gi;

    while ((match = escapedRegex.exec(html))) {
        urls.add(
            match[0]
                .replace(/\\u0026/g, "&")
                .replace(/\\\//g, "/")
        );
    }

    return [...urls].filter(url => {
        const lower = url.toLowerCase();

        return (
            !lower.includes("logo") &&
            !lower.includes("avatar") &&
            !lower.includes("favicon") &&
            !lower.includes("icon")
        );
    });
}

function extractNextData(html) {
    const match = html.match(
        /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
    );

    if (!match) return null;

    try {
        return JSON.parse(match[1]);
    } catch {
        return null;
    }
}

function recursivelyFindImages(value, found = []) {
    if (!value) return found;

    if (typeof value === "string") {
        if (
            /^https?:\/\//i.test(value) &&
            /\.(jpg|jpeg|png|webp)(\?|$)/i.test(value)
        ) {
            found.push(value);
        }

        return found;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            recursivelyFindImages(item, found);
        }

        return found;
    }

    if (typeof value === "object") {
        for (const item of Object.values(value)) {
            recursivelyFindImages(item, found);
        }
    }

    return found;
}

async function searchManga(query) {
    const response = await http.get("/comics/");

    const links = extractLinks(response.data);

    const unique = new Map();

    for (const item of links) {
        if (!item.url) continue;

        if (!unique.has(item.url)) {
            unique.set(item.url, item);
        }
    }

    const mangas = [...unique.values()];

    const ranked = mangas
        .map(item => ({
            ...item,
            score: similarity(query, item.text)
        }))
        .sort((a, b) => b.score - a.score);

    return ranked.filter(item => item.score >= 35).slice(0, 10);
}

async function getChapter(mangaUrl, chapterNumber) {
    const response = await http.get(
        new URL(mangaUrl).pathname
    );

    const html = response.data;

    const links = extractChapterLinks(html);

    if (!links.length) {
        throw new Error(
            "No chapter links found on the Asura manga page."
        );
    }

    const target = String(chapterNumber);

    let chapter = null;

    for (const link of links) {
        const text = link.text;

        const match = text.match(
            /chapter\s+(\d+(?:\.\d+)?)/i
        );

        if (!match) continue;

        const number = match[1];

        if (
            number === target ||
            Number(number) === Number(target)
        ) {
            chapter = link;
            break;
        }
    }

    if (!chapter) {
        throw new Error(
            `Chapter ${chapterNumber} was not found on Asura Scans.`
        );
    }

    const chapterResponse = await http.get(
        new URL(chapter.url).pathname
    );

    const chapterHtml = chapterResponse.data;

    let images = extractImageUrls(chapterHtml);

    // Try Next.js data if available.
    const nextData = extractNextData(chapterHtml);

    if (nextData) {
        images.push(
            ...recursivelyFindImages(nextData)
        );
    }

    images = [...new Set(images)];

    if (!images.length) {
        throw new Error(
            "Asura Scans chapter page returned no images."
        );
    }

    return {
        chapter: target,
        pages: images,
        url: chapter.url
    };
}

module.exports = {
    name: "Asura Scans",

    async getChapter(mangaName, chapterNumber) {
        const mangas = await searchManga(mangaName);

        if (!mangas.length) {
            throw new Error(
                `No manga found for "${mangaName}" on Asura Scans.`
            );
        }

        const manga = mangas[0];

        const result = await getChapter(
            manga.url,
            chapterNumber
        );

        return {
            title: manga.text || mangaName,
            chapter: result.chapter,
            source: "Asura Scans",
            pages: result.pages
        };
    }
};
