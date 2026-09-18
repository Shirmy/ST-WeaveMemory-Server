"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerRoutes = registerRoutes;
const body_parser_1 = __importDefault(require("body-parser"));
const protocol_1 = require("../protocol");
function requiredString(value, name) {
    if (typeof value !== 'string' || !value.trim())
        throw new Error(`${name} is required`);
    return value;
}
function registerRoutes(router, runtime) {
    const json = body_parser_1.default.json({ limit: '2mb' });
    router.get('/health', (_req, res) => res.json({
        ok: true,
        plugin: 'weavememory',
        backendVersion: protocol_1.BACKEND_VERSION,
        apiVersion: protocol_1.API_VERSION,
        schemaVersion: protocol_1.SCHEMA_VERSION,
        capabilities: ['generation-gate', 'floor-binding', 'state-chain-planned', 'long-memory-planned']
    }));
    router.post('/generation/prepare', json, async (req, res) => {
        try {
            const body = req.body ?? {};
            const payload = {
                chatId: requiredString(body.chatId, 'chatId'),
                generationType: String(body.generationType ?? 'normal'),
                contextSize: Number(body.contextSize) || 0,
                latestUserIndex: Number.isSafeInteger(body.latestUserIndex) ? body.latestUserIndex : null,
                latestUserText: String(body.latestUserText ?? '')
            };
            return res.json(await runtime.prepareGeneration(payload));
        }
        catch (error) {
            return res.status(400).json({ ready: false, reason: error instanceof Error ? error.message : 'invalid request' });
        }
    });
    router.post('/floor/finalize', json, async (req, res) => {
        try {
            const body = req.body ?? {};
            const payload = {
                chatId: requiredString(body.chatId, 'chatId'),
                messageIndex: Number(body.messageIndex),
                swipeId: Number.isSafeInteger(body.swipeId) ? body.swipeId : null,
                content: String(body.content ?? '')
            };
            if (!Number.isSafeInteger(payload.messageIndex) || payload.messageIndex < 0)
                throw new Error('messageIndex is invalid');
            if (!payload.content)
                throw new Error('content is required');
            return res.json(await runtime.finalizeFloor(payload));
        }
        catch (error) {
            return res.status(400).json({ accepted: false, error: error instanceof Error ? error.message : 'invalid request' });
        }
    });
}
