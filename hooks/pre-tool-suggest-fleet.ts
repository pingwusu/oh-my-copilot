// Reference PreToolUse hook bundled with the plugin install. Re-exports the
// suggest-fleet hook from src/hooks/ so users get the same advisory text the
// in-process registry uses.

export { suggestFleetHook as default } from "../src/hooks/suggest-fleet.js";
export { suggestFleetHook as hook } from "../src/hooks/suggest-fleet.js";
