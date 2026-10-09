"use strict";

// CLIP indexer worker. Runs under Electron's utilityProcess (plain Node —
// same environment as the site's build script, which is where this logic
// comes from). Owns the single CLIP model instance and answers:
//   { type: "init" }                      → { type: "init-done", ok, modelId, dim, textMean, error }
//   { type: "embed-photo", path, filename } → { type: "photo-done", id, ok, vec, phrase, error }
//   { type: "embed-video", path, filename } → { type: "video-done", id, ok, vec, phrase, error }
//   { type: "embed-query", text }         → { type: "query-done", id, ok, vec, error }
//   { type: "embed-phrase", filename }    → { type: "phrase-done", id, ok, vec, error }
//   { type: "get-text-mean" }             → { type: "text-mean-done", id, ok, textMean, error }
