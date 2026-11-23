"use strict";

const bundled = require("./commands.json");
const { USER_AGENT } = require("./client");

/**
 * How long a fetched command list is kept before asking again.
 */
const CACHE_MS = 10 * 60000;

/**
 * @type {Map<string, { at: number, catalog: Catalog }>}
 */
const cache = new Map();

/**
 * @typedef {{ name: string, description: string, options: string[] }} CommandInfo
 * @typedef {{ limits: object, commands: CommandInfo[] }} Catalog
 */

/**
 * The command list shipped with these nodes, for when jaeconnect can't be asked.
 *
 * @returns {Catalog} The list.
 */
const bundledCatalog = () => bundled;

/**
 * Every command jaeconnect takes, with its options and limits, read from the API's own description (the
 * `x-commands` on the command endpoint) so new commands show up without updating these nodes. Falls back to the
 * shipped list when the description can't be read.
 *
 * @param {string} baseUrl The API address.
 * @param {typeof fetch} [fetchImpl] The fetch to use (tests).
 * @returns {Promise<Catalog>} The commands.
 */
const fetchCatalog = async (baseUrl, fetchImpl = fetch) => {
    const cached = cache.get(baseUrl);
    if (cached && Date.now() - cached.at < CACHE_MS) {
        return cached.catalog;
    }

    try {
        const response = await fetchImpl(`${baseUrl}/openapi/v1.json`, {
            headers: { Accept: "application/json", "User-Agent": USER_AGENT },
            signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) {
            return bundled;
        }

        const document = await response.json();
        const extension = document?.paths?.["/v1/vehicles/{id}/commands/{command}"]?.post?.["x-commands"];
        if (!extension || !Array.isArray(extension.commands)) {
            return bundled;
        }

        const catalog = {
            limits: extension.limits ?? bundled.limits,
            commands: extension.commands.map((c) => ({ name: c.name, description: c.description, options: c.options ?? [] })),
        };
        cache.set(baseUrl, { at: Date.now(), catalog });
        return catalog;
    } catch {
        return bundled;
    }
};

/**
 * The options a command takes, from the shipped list.
 *
 * @param {string} command The command's name.
 * @returns {string[] | undefined} Its option names, or undefined for a command the shipped list doesn't know.
 */
const optionsFor = (command) => bundled.commands.find((c) => c.name === command)?.options;

module.exports = { bundledCatalog, fetchCatalog, optionsFor };
