"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { SseParser } = require("../lib/sse");

test("parses events split across chunks, with any line ending", () => {
    const parser = new SseParser();
    const events = [
        ...parser.push("retry: 5000\n\n: ping\n\nid: evt_1\nevent: vehicle.lo"),
        ...parser.push("cked\ndata: {\"a\":1}\r"),
        ...parser.push("\n\r\nid: evt_2\rdata: line one\rdata: line two\r\r\n"),
    ];

    assert.deepEqual(events, [
        { id: "evt_1", event: "vehicle.locked", data: "{\"a\":1}" },
        { id: "evt_2", event: "message", data: "line one\nline two" },
    ]);
    assert.equal(parser.retryMs, 5000);
    assert.equal(parser.lastEventId, "evt_2");
});

test("ignores comments and blank events", () => {
    const parser = new SseParser();
    assert.deepEqual(parser.push(": ping\n\n\n\nevent: nothing\n\n"), []);
});
