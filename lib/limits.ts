// What a store accepts: the ai_toolkit server's limits (api/evidence_routes.py, evidence/record.py),
// which the browser store keeps too. The views use the same numbers for their inputs, so a value
// that fits a field also passes the store.

export const MAX_CASE_NAME = 200;
export const MAX_TAG = 64;
export const MAX_TAGS = 64;
export const MAX_NOTE = 20_000;
export const MAX_NOTES = 200;
export const MAX_TODO = 2000;
export const MAX_TODOS = 500;

/** Artifact names become file names on the server: a safe alphabet, at most 100 characters. */
export const ARTIFACT_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** A tag (or a case name) as the stores spell it: trimmed, inner whitespace collapsed. */
export const normalizeTag = (text: string) => text.trim().replace(/\s+/g, ' ');
