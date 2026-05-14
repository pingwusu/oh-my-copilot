// Public package surface for oh-my-copilot.
// Most users will reach for the `omcp` CLI; consumers integrating
// programmatically import from here.

export { runCli } from "./cli/omcp.js";
export type { ModelFamily } from "./runtime/model-routing.js";
