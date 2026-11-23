"use strict";

const { JaeConnectError, normaliseBaseUrl, request } = require("../lib/client");
const { fetchCatalog } = require("../lib/commands");
const { EventStream } = require("../lib/stream");

/**
 * Commands wait for the car (up to about 60 s, plus up to 40 s to wake it), so they get longer than other calls.
 */
const COMMAND_TIMEOUT_MS = 150000;

/**
 * How long the account's car list is kept, for nodes that pick the only car when none is chosen.
 */
const VEHICLES_CACHE_MS = 5 * 60000;

/**
 * The password placeholder the editor sends back for a token it already has.
 */
const PASSWORD_PLACEHOLDER = "__PWRD__";

/**
 * A short time for status text, in the Node-RED host's local time.
 */
const clock = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Status text is cut short in the editor, so keep it brief.
 */
const shorten = (text, length = 40) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

/**
 * Puts an API failure's details on the message (as `msg.problem`) so a Catch node can act on its `code`.
 */
const withProblem = (msg, error) => {
    if (!(error instanceof JaeConnectError)) {
        return;
    }

    if (error.problem) {
        msg.problem = error.problem;
        return;
    }

    // Raised here rather than by jaeconnect (no token, no car chosen, a bad option): the same shape, minus what's unknown.
    msg.problem = { code: error.code, detail: error.message };
    if (error.status !== undefined) {
        msg.problem.status = error.status;
    }
};

module.exports = function (RED) {
    /**
     * The jaeconnect account: the API address and token, shared by the other nodes, and the one event stream they
     * all listen to.
     */
    function JaeConnectAccountNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.name = config.name;
        node.baseUrl = normaliseBaseUrl(config.baseUrl);

        /**
         * Calls the API with this account's token.
         */
        node.api = (method, path, body, timeoutMs) =>
            request({ baseUrl: node.baseUrl, token: node.credentials?.token, method, path, body, timeoutMs });

        let vehicles;
        /**
         * The account's cars, kept for a few minutes.
         */
        node.vehicles = async () => {
            if (!vehicles || Date.now() - vehicles.at > VEHICLES_CACHE_MS) {
                vehicles = { at: Date.now(), list: await node.api("GET", "/v1/vehicles") };
            }

            return vehicles.list;
        };

        /**
         * The car a node should act on: its own choice, else `msg.vehicle_id`, else the account's only car.
         */
        node.resolveVehicle = async (chosen, msg) => {
            const id = chosen || (typeof msg.vehicle_id === "string" ? msg.vehicle_id : "");
            if (id) {
                return id;
            }

            const list = await node.vehicles();
            if (list.length === 1) {
                return list[0].id;
            }

            throw new JaeConnectError(
                list.length === 0 ? "This token can't see any cars." : "Choose a car in the node, or set msg.vehicle_id.",
                { code: "vehicle_required" },
            );
        };

        const listeners = new Set();
        let stream;
        let lastState = { state: "stopped" };

        /**
         * Starts listening to the event stream. The stream opens with the first listener and closes with the last.
         *
         * @returns {() => void} Stops listening.
         */
        node.subscribe = (listener) => {
            listeners.add(listener);
            listener.onState(lastState);
            if (!stream) {
                stream = new EventStream({
                    baseUrl: node.baseUrl,
                    token: node.credentials?.token,
                    onEvent: (event) => listeners.forEach((l) => l.onEvent(event)),
                    onState: (state) => {
                        lastState = state;
                        if (state.state === "error") {
                            node.error(`Event stream stopped: ${state.message}`);
                        }

                        listeners.forEach((l) => l.onState(state));
                    },
                    warn: (message) => node.warn(message),
                });
                stream.start();
            }

            return () => {
                listeners.delete(listener);
                if (listeners.size === 0 && stream) {
                    stream.stop();
                    stream = undefined;
                    lastState = { state: "stopped" };
                }
            };
        };

        node.on("close", (done) => {
            stream?.stop();
            stream = undefined;
            listeners.clear();
            done();
        });
    }

    RED.nodes.registerType("jaeconnect-account", JaeConnectAccountNode, {
        credentials: { token: { type: "password" } },
    });

    /**
     * Sends a message for each jaeconnect event: charging, locks, status changes, location, geo-fences, finished
     * commands and billing changes.
     */
    function JaeConnectEventNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const account = RED.nodes.getNode(config.account);
        const vehicle = config.vehicle || "";
        const types = Array.isArray(config.types) ? config.types.filter(Boolean) : [];
        if (!account) {
            node.status({ fill: "red", shape: "ring", text: "no account" });
            return;
        }

        let connected = false;
        const unsubscribe = account.subscribe({
            onEvent: (event) => {
                if (vehicle && event.vehicle_id !== vehicle) {
                    return;
                }

                if (types.length > 0 && !types.includes(event.type)) {
                    return;
                }

                node.send({ topic: event.type, payload: event.data, vehicle_id: event.vehicle_id ?? null, event });
                node.status({ fill: "green", shape: "dot", text: shorten(`${event.type.replace(/^vehicle\./, "")} · ${clock()}`) });
            },
            onState: (state) => {
                switch (state.state) {
                    case "connected":
                        if (!connected) {
                            node.status({ fill: "green", shape: "dot", text: "connected" });
                        }

                        connected = true;
                        break;
                    case "connecting":
                        node.status({ fill: "yellow", shape: "dot", text: "connecting" });
                        connected = false;
                        break;
                    case "reconnecting":
                        node.status({ fill: "yellow", shape: "ring", text: shorten(`retrying in ${Math.round((state.retryMs ?? 0) / 1000)} s`) });
                        connected = false;
                        break;
                    case "error":
                        node.status({ fill: "red", shape: "ring", text: shorten(state.message ?? "stopped") });
                        connected = false;
                        break;
                    default:
                        node.status({});
                        connected = false;
                        break;
                }
            },
        });

        node.on("close", (done) => {
            unsubscribe();
            node.status({});
            done();
        });
    }

    RED.nodes.registerType("jaeconnect-event", JaeConnectEventNode);

    /**
     * Reads a car's status, its location, its details, or the account's cars, when a message arrives.
     */
    function JaeConnectStatusNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const account = RED.nodes.getNode(config.account);
        const what = config.what || "status";
        if (!account) {
            node.status({ fill: "red", shape: "ring", text: "no account" });
        }

        node.on("input", async (msg, send, done) => {
            if (!account) {
                done(new Error("Choose a jaeconnect account."));
                return;
            }

            try {
                const refresh = typeof msg.refresh === "boolean" ? msg.refresh : Boolean(config.refresh);
                const query = refresh ? "?refresh=true" : "";
                if (what === "cars") {
                    msg.payload = await account.api("GET", "/v1/vehicles");
                } else {
                    const id = encodeURIComponent(await account.resolveVehicle(config.vehicle, msg));
                    msg.vehicle_id = decodeURIComponent(id);
                    const path = {
                        status: `/v1/vehicles/${id}/status${query}`,
                        location: `/v1/vehicles/${id}/location${query}`,
                        car: `/v1/vehicles/${id}`,
                        schedules: `/v1/vehicles/${id}/schedules`,
                    }[what];
                    msg.payload = await account.api("GET", path ?? `/v1/vehicles/${id}/status${query}`);
                }

                msg.topic = msg.topic || `jaeconnect/${what}`;
                node.status({ fill: "green", shape: "dot", text: `${what} · ${clock()}` });
                send(msg);
                done();
            } catch (error) {
                node.status({ fill: "red", shape: "ring", text: shorten(error.code ?? error.message) });
                withProblem(msg, error);
                done(error);
            }
        });
    }

    RED.nodes.registerType("jaeconnect-status", JaeConnectStatusNode);

    /**
     * Sends a command to a car (lock, climate, charging…) and passes on jaeconnect's record of how it went.
     */
    function JaeConnectCommandNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const account = RED.nodes.getNode(config.account);
        if (!account) {
            node.status({ fill: "red", shape: "ring", text: "no account" });
        }

        node.on("input", async (msg, send, done) => {
            if (!account) {
                done(new Error("Choose a jaeconnect account."));
                return;
            }

            const command = config.command || (typeof msg.command === "string" ? msg.command : "");
            try {
                if (!command) {
                    throw new JaeConnectError("Choose a command in the node, or set msg.command.", { code: "command_required" });
                }

                const vehicleId = await account.resolveVehicle(config.vehicle, msg);
                const body = await buildBody(account.baseUrl, command, config, msg.payload);
                node.status({ fill: "blue", shape: "dot", text: shorten(`${command}…`) });
                const result = await account.api(
                    "POST",
                    `/v1/vehicles/${encodeURIComponent(vehicleId)}/commands/${encodeURIComponent(command)}`,
                    body,
                    COMMAND_TIMEOUT_MS,
                );

                msg.payload = result;
                msg.vehicle_id = vehicleId;
                msg.command = command;
                msg.topic = msg.topic || `jaeconnect/${command}`;
                if (result?.status === "failed") {
                    // The car answered, but the command didn't work: jaeconnect returns 200 with status failed.
                    const message = result.error?.message ?? `${command} failed.`;
                    node.status({ fill: "red", shape: "ring", text: shorten(`${command}: ${result.error?.code ?? "failed"}`) });
                    msg.problem = { code: result.error?.code, detail: message };
                    done(new Error(message));
                    return;
                }

                node.status({ fill: "green", shape: "dot", text: shorten(`${command} ✓ ${clock()}`) });
                send(msg);
                done();
            } catch (error) {
                node.status({ fill: "red", shape: "ring", text: shorten(`${command || "command"}: ${error.code ?? error.message}`) });
                withProblem(msg, error);
                done(error);
            }
        });
    }

    RED.nodes.registerType("jaeconnect-command", JaeConnectCommandNode);

    /**
     * Builds a command's body from the node's settings, overridden by an object `msg.payload`, keeping only the
     * options the command takes (jaeconnect refuses any others).
     */
    async function buildBody(baseUrl, command, config, payload) {
        const fromPayload = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
        const values = {
            temperature_c: fromPayload.temperature_c ?? config.temperature,
            duration_minutes: fromPayload.duration_minutes ?? config.duration,
            seat: fromPayload.seat ?? config.seat,
            level: fromPayload.level ?? config.level,
        };

        const catalog = await fetchCatalog(baseUrl);
        const info = catalog.commands.find((c) => c.name === command);
        const allowed = info ? info.options : Object.keys(values);
        const body = {};
        for (const option of allowed) {
            const value = values[option];
            if (value === undefined || value === null || value === "") {
                continue;
            }

            if (option === "seat") {
                body.seat = String(value);
                continue;
            }

            const number = Number(value);
            if (!Number.isFinite(number)) {
                throw new JaeConnectError(`${option} must be a number (got "${value}").`, { code: "validation_failed" });
            }

            body[option] = number;
        }

        return Object.keys(body).length > 0 ? body : undefined;
    }

    /**
     * For the editor: the account's cars and the commands jaeconnect takes. The editor sends the token when it has
     * just been typed (and isn't deployed yet); otherwise the deployed account's token is used.
     */
    RED.httpAdmin.post("/jaeconnect/catalog", RED.auth.needsPermission("jaeconnect.read"), async (req, res) => {
        const { account: accountId, baseUrl: typedBaseUrl, token: typedToken } = req.body ?? {};
        const deployed = accountId ? RED.nodes.getNode(accountId) : undefined;
        const baseUrl = normaliseBaseUrl(typedBaseUrl ?? deployed?.baseUrl);
        if (!/^https?:\/\//i.test(baseUrl)) {
            res.status(400).json({ error: "The API address must start with http:// or https://." });
            return;
        }

        const token =
            typedToken && typedToken !== PASSWORD_PLACEHOLDER
                ? typedToken
                : (deployed?.credentials?.token ?? (accountId ? RED.nodes.getCredentials(accountId)?.token : undefined));

        const catalog = await fetchCatalog(baseUrl);
        let vehicles = null;
        let vehiclesError = null;
        if (token) {
            try {
                const list = await request({ baseUrl, token, path: "/v1/vehicles", timeoutMs: 15000 });
                vehicles = list.map((v) => ({
                    id: v.id,
                    name: v.nickname || [v.brand, v.model].filter(Boolean).join(" ") || v.id,
                    vin_last4: v.vin_last4,
                    supported_commands: v.supported_commands ?? [],
                    permissions: v.permissions,
                }));
            } catch (error) {
                vehiclesError = error.message;
            }
        } else {
            vehiclesError = "Add the account's API token to list its cars.";
        }

        res.json({ vehicles, vehicles_error: vehiclesError, commands: catalog.commands, limits: catalog.limits });
    });
};
