"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { JaeConnectError, normaliseBaseUrl, request } = require("../lib/client");

const respond = (status, body) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

test("normalises the address", () => {
    assert.equal(normaliseBaseUrl(""), "https://www.jaeconnect.com");
    assert.equal(normaliseBaseUrl(undefined), "https://www.jaeconnect.com");
    assert.equal(normaliseBaseUrl(" http://localhost:5180/ "), "http://localhost:5180");
    assert.equal(normaliseBaseUrl("https://www.jaeconnect.com/"), "https://www.jaeconnect.com");
});

test("sends the bare domain, the old default, to www so the token survives", () => {
    for (const typed of ["https://jaeconnect.com", "https://jaeconnect.com/", "jaeconnect.com", "http://jaeconnect.com", " HTTPS://JaeConnect.com// "]) {
        assert.equal(normaliseBaseUrl(typed), "https://www.jaeconnect.com", typed);
    }
    assert.equal(normaliseBaseUrl("https://jaeconnect.com.example.org"), "https://jaeconnect.com.example.org");
    assert.equal(normaliseBaseUrl("https://staging.jaeconnect.com"), "https://staging.jaeconnect.com");
});

test("returns the JSON and sends the token", async () => {
    let seen;
    const fetchImpl = async (url, init) => {
        seen = { url, init };
        return new Response(JSON.stringify([{ id: "car1" }]), { status: 200 });
    };

    const result = await request({ baseUrl: "http://x", token: "jc_pat_t", path: "/v1/vehicles", fetchImpl });
    assert.deepEqual(result, [{ id: "car1" }]);
    assert.equal(seen.url, "http://x/v1/vehicles");
    assert.equal(seen.init.headers.Authorization, "Bearer jc_pat_t");
    assert.equal(seen.init.body, undefined);
});

test("turns problem details into an error with the code", async () => {
    const problem = { title: "Location sharing is off", status: 403, detail: "Turn on location sharing.", code: "location_sharing_off" };
    await assert.rejects(
        request({ baseUrl: "http://x", token: "t", path: "/v1/vehicles/a/location", fetchImpl: respond(403, problem) }),
        (error) => error instanceof JaeConnectError && error.code === "location_sharing_off" && error.status === 403 && error.message === "Turn on location sharing.",
    );
});

test("refuses to call without a token", async () => {
    await assert.rejects(request({ baseUrl: "http://x", token: "", path: "/v1/vehicles" }), /No API token/);
});
