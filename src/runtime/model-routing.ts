// Maps an agent's dual-model declaration to a concrete Copilot model string.
//
// Resolution order:
//   1. explicit override (CLI flag or function arg)
//   2. OMCP_MODEL_FAMILY env var
//   3. ~/.copilot/config.json `model` field
//   4. "claude" (Copilot default)

export type ModelFamily = "claude" | "gpt";

export interface DualModel {
  claude: string;
  gpt: string;
}

export const DEFAULT_FAMILY: ModelFamily = "claude";

export function resolveFamily(
  override: ModelFamily | "auto" | undefined,
  env: NodeJS.ProcessEnv,
  copilotConfigModel: string | undefined,
): ModelFamily {
  if (override && override !== "auto") return override;

  const envValue = env.OMCP_MODEL_FAMILY?.toLowerCase();
  if (envValue === "claude" || envValue === "gpt") return envValue;

  if (copilotConfigModel) {
    if (copilotConfigModel.startsWith("claude")) return "claude";
    if (copilotConfigModel.startsWith("gpt")) return "gpt";
  }

  return DEFAULT_FAMILY;
}

export function pickModel(dual: DualModel, family: ModelFamily): string {
  return family === "claude" ? dual.claude : dual.gpt;
}
