"use strict";

function cleanText(value = "") {
    return String(value).replace(/\s+/g, " ").trim();
}

const CITY_ALIASES = new Map([
    ["allen", "Allen"],
    ["arlington", "Arlington"],
    ["bedford", "Bedford"],
    ["carrollton", "Carrollton"],
    ["celina", "Celina"],
    ["colleyville", "Colleyville"],
    ["corinth", "Corinth"],
    ["coppell", "Coppell"],
    ["dallas", "Dallas"],
    ["dalworthington gardens", "Dalworthington Gardens"],
    ["desoto", "DeSoto"],
    ["euless", "Euless"],
    ["flower mound", "Flower Mound"],
    ["fort worth", "Fort Worth"],
    ["frisco", "Frisco"],
    ["garland", "Garland"],
    ["grand prairie", "Grand Prairie"],
    ["grapevine", "Grapevine"],
    ["haltom city", "Haltom City"],
    ["highland village", "Highland Village"],
    ["hurst", "Hurst"],
    ["irving", "Irving"],
    ["kennedale", "Kennedale"],
    ["lake dallas", "Lake Dallas"],
    ["lewisville", "Lewisville"],
    ["little elm", "Little Elm"],
    ["lowry crossing", "Lowry Crossing"],
    ["mansfield", "Mansfield"],
    ["mckinney", "McKinney"],
    ["melissa", "Melissa"],
    ["mesquite", "Mesquite"],
    ["north richland hills", "North Richland Hills"],
    ["pantego", "Pantego"],
    ["plano", "Plano"],
    ["prosper", "Prosper"],
    ["richardson", "Richardson"],
    ["richland hills", "Richland Hills"],
    ["sachse", "Sachse"],
    ["the colony", "The Colony"],
    ["wylie", "Wylie"],
]);

const NEIGHBORHOOD_ALIASES = [
    ["craig ranch", "McKinney"],
    ["eldorado", "McKinney"],
    ["trinity falls", "McKinney"],
    ["stonebridge ranch", "McKinney"],
    ["westridge", "McKinney"],
    ["mckinney north", "McKinney"],
];

function findKnownCity(value = "") {
    const lower = cleanText(value).toLowerCase();

    for (const [needle, city] of CITY_ALIASES.entries()) {
        if (lower.includes(needle)) {
            return city;
        }
    }

    for (const [needle, city] of NEIGHBORHOOD_ALIASES) {
        if (lower.includes(needle)) {
            return city;
        }
    }

    return null;
}

module.exports = async function normalizeCity({
    city,
    state,
    location,
    description,
}) {
    const known =
        findKnownCity(location) ||
        findKnownCity(city) ||
        findKnownCity(description);

    return {
        city: known || cleanText(city) || null,
        state: cleanText(state || "TX").toUpperCase() || "TX",
    };
};
