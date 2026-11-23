"use strict";

const { USER_AGENT, errorFromResponse } = require("./client");
const { SseParser } = require("./sse");

/**
 * jaeconnect sends a `: ping` every 25 s, so this long without a byte means the connection has quietly died.
 */
const IDLE_MS = 70000;

/**
 * The first wait before reconnecting, doubled after each failure up to {@link MAX_BACKOFF_MS}.
 */
const BASE_BACKOFF_MS = 2000;

const MAX_BACKOFF_MS = 60000;

/**
 * How long to wait while the account has no active subscription (402): it won't change quickly.
 */
const SUBSCRIPTION_RETRY_MS = 5 * 60000;

/**
 * Keeps `GET /v1/events` open: reconnects after a drop with `Last-Event-ID` so nothing is missed, backs off when
 * jaeconnect is unreachable, and gives up only when the token itself is refused.
 */
class EventStream {
    /**
     * @param {object} options
     * @param {string} options.baseUrl The API address (no trailing slash).
     * @param {string | undefined} options.token The API token.
     * @param {(event: object) => void} options.onEvent Called with each event's parsed JSON.
     * @param {(state: { state: "connecting" | "connected" | "reconnecting" | "stopped" | "error", message?: string, retryMs?: number }) => void} options.onState
     * Called when the connection's state changes.
     * @param {(message: string) => void} [options.warn] Logs something odd that isn't fatal.
     * @param {typeof fetch} [options.fetchImpl] The fetch to use (tests).
     * @param {number} [options.idleMs] How long without a byte before reconnecting (tests).
     */
    constructor({ baseUrl, token, onEvent, onState, warn = () => {}, fetchImpl = fetch, idleMs = IDLE_MS }) {
        this.baseUrl = baseUrl;
        this.token = token;
        this.onEvent = onEvent;
        this.onState = onState;
        this.warn = warn;
        this.fetchImpl = fetchImpl;
        this.idleMs = idleMs;
        this.running = false;
        this.failures = 0;
        this.lastEventId = undefined;
        this.controller = undefined;
        this.wake = undefined;
    }

    /**
     * Opens the stream, if it isn't open already.
     */
    start() {
        if (this.running) {
            return;
        }

        this.running = true;
        void this.loop();
    }

    /**
     * Closes the stream for good.
     */
    stop() {
        this.running = false;
        this.controller?.abort();
        this.wake?.();
    }

    /**
     * @private
     */
    async loop() {
        if (!this.token) {
            this.running = false;
            this.onState({ state: "error", message: "No API token: add one to the jaeconnect account node." });
            return;
        }

        let delay = 0;
        while (this.running) {
            if (delay > 0) {
                await this.sleep(delay);
                if (!this.running) {
                    break;
                }
            }

            this.onState({ state: "connecting" });
            const outcome = await this.connectOnce();
            if (!this.running) {
                break;
            }

            if (outcome.fatal) {
                this.running = false;
                this.onState({ state: "error", message: outcome.message });
                return;
            }

            delay = outcome.retryMs;
            this.onState({ state: "reconnecting", message: outcome.message, retryMs: delay });
        }

        this.onState({ state: "stopped" });
    }

    /**
     * Connects once and reads until the connection ends.
     *
     * @private
     * @returns {Promise<{ fatal?: boolean, message?: string, retryMs: number }>} Whether to try again, and when.
     */
    async connectOnce() {
        const controller = new AbortController();
        this.controller = controller;
        const headers = {
            Accept: "text/event-stream",
            Authorization: `Bearer ${this.token}`,
            "Cache-Control": "no-cache",
            "User-Agent": USER_AGENT,
        };
        if (this.lastEventId) {
            headers["Last-Event-ID"] = this.lastEventId;
        }

        let response;
        try {
            response = await this.fetchImpl(`${this.baseUrl}/v1/events`, { headers, signal: controller.signal });
        } catch (error) {
            return { message: `Couldn't reach jaeconnect: ${error.cause?.message ?? error.message}`, retryMs: this.backoff() };
        }

        if (!response.ok) {
            const error = errorFromResponse(response.status, await response.text().catch(() => ""));
            if (response.status === 401 || response.status === 403) {
                return { fatal: true, message: error.message, retryMs: 0 };
            }

            if (response.status === 402) {
                return { message: error.message, retryMs: SUBSCRIPTION_RETRY_MS };
            }

            const retryAfter = Number(response.headers.get("retry-after"));
            return { message: error.message, retryMs: retryAfter > 0 ? retryAfter * 1000 : this.backoff() };
        }

        this.failures = 0;
        this.onState({ state: "connected" });

        const parser = new SseParser();
        const decoder = new TextDecoder();
        let idle;
        const armIdle = () => {
            clearTimeout(idle);
            idle = setTimeout(() => controller.abort(), this.idleMs);
        };

        armIdle();
        try {
            for await (const chunk of response.body) {
                armIdle();
                for (const event of parser.push(decoder.decode(chunk, { stream: true }))) {
                    this.dispatch(event);
                }
            }
        } catch {
            // Aborted (stopped, or idle for too long) or the network dropped: either way, reconnect below.
        } finally {
            clearTimeout(idle);
        }

        // A clean drop reconnects quickly; the server's retry hint (5 s) wins when it gave one.
        return { message: "The connection closed.", retryMs: parser.retryMs ?? BASE_BACKOFF_MS };
    }

    /**
     * @private
     */
    dispatch(event) {
        if (event.id) {
            this.lastEventId = event.id;
        }

        let parsed;
        try {
            parsed = JSON.parse(event.data);
        } catch {
            this.warn(`Skipped an event that wasn't JSON (${event.event}).`);
            return;
        }

        try {
            this.onEvent(parsed);
        } catch (error) {
            this.warn(`An event handler failed: ${error.message}`);
        }
    }

    /**
     * The next wait after a failure: doubling, capped, with a little jitter so many clients don't return at once.
     *
     * @private
     */
    backoff() {
        const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.failures);
        this.failures += 1;
        return Math.round(base * (0.8 + Math.random() * 0.4));
    }

    /**
     * Waits, unless {@link stop} is called first.
     *
     * @private
     */
    sleep(ms) {
        return new Promise((resolve) => {
            const timer = setTimeout(done, ms);
            function done() {
                clearTimeout(timer);
                resolve();
            }

            this.wake = done;
        });
    }
}

module.exports = { EventStream };
