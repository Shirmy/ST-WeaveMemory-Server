"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.info = void 0;
exports.init = init;
exports.exit = exit;
const routes_1 = require("./api/routes");
const runtime_1 = require("./core/runtime");
const per_chat_queue_1 = require("./queue/per-chat-queue");
const memory_store_1 = require("./storage/memory-store");
const runtime = new runtime_1.MemoryRuntime(new memory_store_1.InMemoryStore(), new per_chat_queue_1.PerChatQueue());
async function init(router) {
    (0, routes_1.registerRoutes)(router, runtime);
    console.log('[WeaveMemory] server v0.1.0 loaded');
}
async function exit() {
    console.log('[WeaveMemory] server stopped');
}
exports.info = {
    id: 'weavememory',
    name: 'WeaveMemory Server',
    description: 'State-chain and long-term-memory backend for WeaveMemory.'
};
const plugin = { init, exit, info: exports.info };
exports.default = plugin;
