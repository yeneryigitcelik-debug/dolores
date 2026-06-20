/**
 * @dolores/core — the heart: embedder abstraction, hybrid retrieval, extraction.
 *
 * Contracts live in ./types and are re-exported here. The core helper fills in
 * ./embedder, ./retrieval and ./extraction and re-exports them below.
 */
export * from "./types.js";

export * from "./embedder/index.js";
export * from "./retrieval/index.js";
export * from "./extraction/index.js";
