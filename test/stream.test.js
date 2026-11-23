"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { test } = require("node:test");

const { EventStream } = require("../lib/stream");

/**
 * A stand-in for /v1/events: the first connection sends one event then drops, the second must ask to resume.
 */
const startServer = (handler) =>
    new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, "127.0.0.1", () => resolve(server));
    });

test("reconnects after a drop and resumes from the last event", async () => {
    const lastIds = [];
    const server = await startServer((req, res) => {
        lastIds.push(req.headers["last-event-id"]);
        assert.equal(req.headers.authorization, "Bearer t");
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (lastIds.length === 1) {
            res.end("retry: 10\n\nid: evt_1\nevent: vehicle.locked\ndata: {\"id\":\"evt_1\",\"type\":\"vehicle.locked\",\"vehicle_id\":\"car1\",\"data\":{}}\n\n");
        } else {
            res.write("id: evt_2\nevent: vehicle.unlocked\ndata: {\"id\":\"evt_2\",\"type\":\"vehicle.unlocked\",\"vehicle_id\":\"car1\",\"data\":{}}\n\n");
        }
    });

    const { port } = server.address();
    const events = [];
    const states = [];
    await new Promise((resolve) => {
        const stream = new EventStream({
            baseUrl: `http://127.0.0.1:${port}`,
            token: "t",
            onEvent: (event) => {
                events.push(event.type);
                if (events.length === 2) {
                    stream.stop();
                    resolve();
                }
            },
            onState: (state) => states.push(state.state),
        });
        stream.start();
    });

    server.closeAllConnections();
    server.close();
    assert.deepEqual(events, ["vehicle.locked", "vehicle.unlocked"]);
    assert.deepEqual(lastIds, [undefined, "evt_1"]);
    assert.ok(states.includes("reconnecting"));
});

test("gives up when the token is refused", async () => {
    const server = await startServer((req, res) => {
        res.writeHead(401, { "Content-Type": "application/problem+json" });
        res.end(JSON.stringify({ title: "Unauthenticated", status: 401, detail: "The token isn't valid.", code: "unauthenticated" }));
    });

    const { port } = server.address();
    const final = await new Promise((resolve) => {
        const stream = new EventStream({
            baseUrl: `http://127.0.0.1:${port}`,
            token: "bad",
            onEvent: () => {},
            onState: (state) => {
                if (state.state === "error") {
                    resolve(state);
                }
            },
        });
        stream.start();
    });

    server.close();
    assert.equal(final.message, "The token isn't valid.");
});

test("reconnects when the connection goes quiet", async () => {
    let connections = 0;
    const server = await startServer((req, res) => {
        connections += 1;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(": hello\n\n");
    });

    const { port } = server.address();
    const stream = new EventStream({ baseUrl: `http://127.0.0.1:${port}`, token: "t", onEvent: () => {}, onState: () => {}, idleMs: 100 });
    stream.start();
    await new Promise((resolve) => setTimeout(resolve, 2600));
    stream.stop();
    server.closeAllConnections();
    server.close();
    assert.ok(connections >= 2, `expected a reconnect, saw ${connections} connection(s)`);
});
