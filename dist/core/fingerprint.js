"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fingerprint = fingerprint;
const node_crypto_1 = require("node:crypto");
function fingerprint(text) {
    return `sha256:${(0, node_crypto_1.createHash)('sha256').update(text, 'utf8').digest('hex')}`;
}
