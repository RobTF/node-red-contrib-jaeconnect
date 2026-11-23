"use strict";

/**
 * Parses a server-sent event stream (https://html.spec.whatwg.org/multipage/server-sent-events.html) a chunk at a
 * time. Lines may end in CR, LF or CRLF, and a chunk may stop anywhere, even between a CR and its LF.
 */
class SseParser {
    constructor() {
        this.buffer = "";
        this.data = [];
        this.eventType = "";

        /**
         * The last `id:` seen; it carries over to later events, as the spec says.
         * @type {string | undefined}
         */
        this.lastEventId = undefined;

        /**
         * The last `retry:` the server asked for, in milliseconds.
         * @type {number | undefined}
         */
        this.retryMs = undefined;
    }

    /**
     * Adds text from the stream.
     *
     * @param {string} text The next chunk, decoded.
     * @returns {{ id: string | undefined, event: string, data: string }[]} The events it completed.
     */
    push(text) {
        this.buffer += text;
        const events = [];
        for (;;) {
            const match = /\r\n|\r|\n/.exec(this.buffer);
            if (!match) {
                break;
            }

            // A CR at the very end might be the first half of a CRLF: wait for the next chunk.
            if (match[0] === "\r" && match.index === this.buffer.length - 1) {
                break;
            }

            const line = this.buffer.slice(0, match.index);
            this.buffer = this.buffer.slice(match.index + match[0].length);
            const event = this.line(line);
            if (event) {
                events.push(event);
            }
        }

        return events;
    }

    /**
     * Handles one line.
     *
     * @param {string} line The line, without its ending.
     * @returns {{ id: string | undefined, event: string, data: string } | undefined} The event a blank line completed.
     */
    line(line) {
        if (line === "") {
            if (this.data.length === 0) {
                this.eventType = "";
                return undefined;
            }

            const event = { id: this.lastEventId, event: this.eventType || "message", data: this.data.join("\n") };
            this.data = [];
            this.eventType = "";
            return event;
        }

        if (line.startsWith(":")) {
            return undefined;
        }

        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) {
            value = value.slice(1);
        }

        switch (field) {
            case "data":
                this.data.push(value);
                break;
            case "event":
                this.eventType = value;
                break;
            case "id":
                if (!value.includes("\0")) {
                    this.lastEventId = value;
                }
                break;
            case "retry":
                if (/^\d+$/.test(value)) {
                    this.retryMs = Number(value);
                }
                break;
            default:
                break;
        }

        return undefined;
    }
}

module.exports = { SseParser };
