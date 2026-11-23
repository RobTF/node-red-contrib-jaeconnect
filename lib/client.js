"use strict";

const { version } = require("../package.json");

/**
 * The jaeconnect service, used when the account node doesn't name another.
 */
const DEFAULT_BASE_URL = "https://jaeconnect.com";

/**
 * Sent with every request so jaeconnect can tell these nodes apart in its logs.
 */
const USER_AGENT = `node-red-contrib-jaeconnect/${version}`;

/**
 * A failed call to the jaeconnect API, carrying its problem details.
 */
class JaeConnectError extends Error {
    /**
     * @param {string} message What went wrong, for people.
     * @param {{ status?: number, code?: string, problem?: object }} [details] The HTTP status, the stable error code
     * (e.g. `vehicle_unreachable`) and the whole problem details object.
     */
    constructor(message, details = {}) {
        super(message);
        this.name = "JaeConnectError";
        this.status = details.status;
        this.code = details.code;
        this.problem = details.problem;
    }
}

/**
 * Tidies an API address: blank becomes the jaeconnect service, and a trailing slash is dropped.
 *
 * @param {string | undefined} url The address as typed.
 * @returns {string} The address to call.
 */
const normaliseBaseUrl = (url) => {
    const trimmed = (url ?? "").trim().replace(/\/+$/, "");
    return trimmed === "" ? DEFAULT_BASE_URL : trimmed;
};

/**
 * Builds the error for a response that wasn't a success, from its problem details when it has them.
 *
 * @param {number} status The HTTP status.
 * @param {string} text The response body.
 * @returns {JaeConnectError} The error.
 */
const errorFromResponse = (status, text) => {
    let problem;
    try {
        problem = text ? JSON.parse(text) : undefined;
    } catch {
        problem = undefined;
    }

    if (problem && typeof problem === "object") {
        const message = problem.detail || problem.title || `jaeconnect answered ${status}`;
        return new JaeConnectError(message, { status, code: problem.code, problem });
    }

    return new JaeConnectError(`jaeconnect answered ${status}${text ? `: ${text.slice(0, 200)}` : ""}`, { status });
};

/**
 * Calls the jaeconnect API and returns its JSON answer.
 *
 * @param {object} options The call.
 * @param {string} options.baseUrl The API address (no trailing slash).
 * @param {string} options.token A personal access token or OAuth access token.
 * @param {string} [options.method] The HTTP method (GET by default).
 * @param {string} options.path The path, starting `/v1/…`.
 * @param {object} [options.body] A JSON body.
 * @param {number} [options.timeoutMs] How long to wait (30 s by default; commands wait for the car, so pass more).
 * @param {typeof fetch} [options.fetchImpl] The fetch to use (tests).
 * @returns {Promise<any>} The parsed answer, or undefined for an empty one.
 */
const request = async ({ baseUrl, token, method = "GET", path, body, timeoutMs = 30000, fetchImpl = fetch }) => {
    if (!token) {
        throw new JaeConnectError("No API token: add one to the jaeconnect account node.", { code: "unauthenticated" });
    }

    const headers = {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": USER_AGENT,
    };
    if (body !== undefined) {
        headers["Content-Type"] = "application/json";
    }

    let response;
    try {
        response = await fetchImpl(`${baseUrl}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        const timedOut = error && (error.name === "TimeoutError" || error.name === "AbortError");
        throw new JaeConnectError(
            timedOut ? `jaeconnect didn't answer within ${Math.round(timeoutMs / 1000)} s.` : `Couldn't reach jaeconnect: ${error.cause?.message ?? error.message}`,
            { code: timedOut ? "timeout" : "network_error" },
        );
    }

    const text = await response.text();
    if (!response.ok) {
        throw errorFromResponse(response.status, text);
    }

    return text ? JSON.parse(text) : undefined;
};

module.exports = { DEFAULT_BASE_URL, USER_AGENT, JaeConnectError, errorFromResponse, normaliseBaseUrl, request };
