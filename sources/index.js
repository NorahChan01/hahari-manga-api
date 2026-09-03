const sourceFiles = [
    "asura",
    "atsumaru",
    "flamecomics",
    "mangaball",
    "mangabuddy",
    "mangadenizi",
    "mangadex",
    "mangahere",
    "mangak",
    "mangakatana",
    "mangalivre",
    "mangapill",
    "mangaread",
    "mangataro",
    "manhuaplus",
    "rawkuma",
    "weebcentral"
];

const sources = [];

for (const file of sourceFiles) {
    try {
        const source = require(`./${file}`);

        if (!source || typeof source.getChapter !== "function") {
            console.warn(
                `[SOURCE] ${file}.js loaded but has no valid getChapter()`
            );
            continue;
        }

        sources.push(source);

        console.log(
            `[SOURCE] Loaded: ${source.name || file}`
        );
    } catch (error) {
        console.error(
            `[SOURCE] Failed to load ${file}.js: ${error.message}`
        );
    }
}

console.log(
    `[SOURCE] ${sources.length}/${sourceFiles.length} sources loaded.`
);

module.exports = sources;
