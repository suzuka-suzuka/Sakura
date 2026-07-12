import assert from "node:assert/strict";
import test from "node:test";

import {
  bindBotRoute,
  canRunBotScopedTask,
  cleanupBotRoutes,
  isBotOfflineEvent,
} from "../src/core/botLifecycle.js";

test("recognizes bot offline protocol events", () => {
  assert.equal(
    isBotOfflineEvent({
      post_type: "notice",
      notice_type: "bot_offline",
    }),
    true
  );
  assert.equal(
    isBotOfflineEvent({
      post_type: "meta_event",
      meta_event_type: "lifecycle",
      sub_type: "disable",
    }),
    true
  );
  assert.equal(
    isBotOfflineEvent({
      post_type: "meta_event",
      meta_event_type: "lifecycle",
      sub_type: "disconnect",
    }),
    true
  );
  assert.equal(
    isBotOfflineEvent({
      post_type: "meta_event",
      meta_event_type: "heartbeat",
      status: { online: false, good: false },
    }),
    true
  );
});

test("does not treat ordinary events as bot offline", () => {
  assert.equal(isBotOfflineEvent(null), false);
  assert.equal(
    isBotOfflineEvent({
      post_type: "notice",
      notice_type: "friend_add",
    }),
    false
  );
  assert.equal(
    isBotOfflineEvent({
      post_type: "meta_event",
      meta_event_type: "heartbeat",
      sub_type: "disable",
    }),
    false
  );
  assert.equal(
    isBotOfflineEvent({
      post_type: "meta_event",
      meta_event_type: "lifecycle",
      sub_type: "connect",
    }),
    false
  );
  assert.equal(
    isBotOfflineEvent({
      post_type: "meta_event",
      meta_event_type: "heartbeat",
      status: { online: true, good: true },
    }),
    false
  );
});

test("bot-scoped tasks only run for the matching online bot", () => {
  const onlineBot = { self_id: 10001 };
  const getBotById = (selfId) => selfId === onlineBot.self_id ? onlineBot : undefined;

  assert.equal(canRunBotScopedTask(null, getBotById), true);
  assert.equal(canRunBotScopedTask(10001, getBotById), true);
  assert.equal(canRunBotScopedTask(10002, getBotById), false);
  assert.equal(canRunBotScopedTask("invalid", getBotById), false);
});

test("cleans the bot bound to the closing route", () => {
  const bindings = new Map();
  const client = {};
  const removed = [];

  bindBotRoute(bindings, "1101018235", client, "reverse:1");

  const removedSelfIds = cleanupBotRoutes(bindings, {
    client,
    routeKey: "reverse:1",
    selfIds: ["1101018235"],
    removeBot: (selfId) => removed.push(selfId),
  });

  assert.deepEqual(removedSelfIds, [1101018235]);
  assert.deepEqual(removed, [1101018235]);
  assert.equal(bindings.has(1101018235), false);
});

test("an old route closing cannot remove a bot rebound to a new route", () => {
  const bindings = new Map();
  const client = {};
  const removed = [];

  bindBotRoute(bindings, 1101018235, client, "reverse:old");
  bindBotRoute(bindings, 1101018235, client, "reverse:new");

  const removedSelfIds = cleanupBotRoutes(bindings, {
    client,
    routeKey: "reverse:old",
    selfIds: [1101018235],
    removeBot: (selfId) => removed.push(selfId),
  });

  assert.deepEqual(removedSelfIds, []);
  assert.deepEqual(removed, []);
  assert.deepEqual(bindings.get(1101018235), {
    client,
    routeKey: "reverse:new",
  });
});

test("route cleanup only removes bots owned by the disconnected client", () => {
  const bindings = new Map();
  const disconnectedClient = {};
  const connectedClient = {};
  const removed = [];

  bindBotRoute(bindings, 10001, disconnectedClient, "forward:1");
  bindBotRoute(bindings, 10002, connectedClient, "forward:2");

  const removedSelfIds = cleanupBotRoutes(bindings, {
    client: disconnectedClient,
    removeBot: (selfId) => removed.push(selfId),
  });

  assert.deepEqual(removedSelfIds, [10001]);
  assert.deepEqual(removed, [10001]);
  assert.equal(bindings.has(10001), false);
  assert.deepEqual(bindings.get(10002), {
    client: connectedClient,
    routeKey: "forward:2",
  });
});

test("an invalid explicit self ID cannot broaden cleanup to the whole route", () => {
  const bindings = new Map();
  const client = {};
  const removed = [];

  bindBotRoute(bindings, 10001, client, "reverse:1");

  const removedSelfIds = cleanupBotRoutes(bindings, {
    client,
    routeKey: "reverse:1",
    selfIds: ["invalid"],
    removeBot: (selfId) => removed.push(selfId),
  });

  assert.deepEqual(removedSelfIds, []);
  assert.deepEqual(removed, []);
  assert.deepEqual(bindings.get(10001), {
    client,
    routeKey: "reverse:1",
  });
});
