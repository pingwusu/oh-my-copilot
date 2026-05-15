// Parse agent frontmatter to extract dual-model declarations and resolve a
// concrete model id for a given agent + family.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type DualModel,
  type ModelFamily,
  resolveFamily,
} from "./model-routing.js";

export interface AgentSpec {
  name: string;
  description?: string;
  model: DualModel;
}

const FALLBACK_DUAL: DualModel = {
  claude: "claude-sonnet-4.6",
  gpt: "gpt-5.2",
};

function parseFrontmatter(text: string): Record<string, string> | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const block = text.slice(3, end);
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_-]+):\s*(.+)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function parseDualModelBlock(text: string): DualModel | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const block = text.slice(3, end);
  const lines = block.split(/\r?\n/);
  let inModel = false;
  let claude: string | undefined;
  let gpt: string | undefined;
  for (const line of lines) {
    if (/^model:\s*$/.test(line)) {
      inModel = true;
      continue;
    }
    if (inModel) {
      const m = line.match(/^\s+(claude|gpt):\s*(.+)$/);
      if (m) {
        if (m[1] === "claude") claude = m[2].trim();
        else gpt = m[2].trim();
      } else if (!/^\s/.test(line) && line.trim() !== "") {
        inModel = false;
      }
    }
  }
  if (claude && gpt) return { claude, gpt };
  return null;
}

export function readAgentSpec(agentFilePath: string): AgentSpec | null {
  if (!existsSync(agentFilePath)) return null;
  const text = readFileSync(agentFilePath, "utf8");
  const fm = parseFrontmatter(text);
  if (!fm || !fm.name) return null;
  const model = parseDualModelBlock(text) ?? FALLBACK_DUAL;
  return { name: fm.name, description: fm.description, model };
}

export function loadAgentCatalog(agentsDir: string): Map<string, AgentSpec> {
  const out = new Map<string, AgentSpec>();
  if (!existsSync(agentsDir)) return out;
  for (const f of readdirSync(agentsDir)) {
    if (!f.endsWith(".md")) continue;
    const spec = readAgentSpec(join(agentsDir, f));
    if (spec) out.set(spec.name, spec);
  }
  return out;
}

export interface ResolveAgentModelInput {
  agent?: string;
  override?: ModelFamily | "auto";
  env: NodeJS.ProcessEnv;
  copilotConfigModel?: string;
  catalog: Map<string, AgentSpec>;
  fallback?: DualModel;
}

export function resolveAgentModel(input: ResolveAgentModelInput): {
  family: ModelFamily;
  model: string;
} {
  const family = resolveFamily(input.override, input.env, input.copilotConfigModel);
  const fallback = input.fallback ?? FALLBACK_DUAL;
  const spec = input.agent ? input.catalog.get(input.agent) : undefined;
  const dual = spec?.model ?? fallback;
  return { family, model: family === "claude" ? dual.claude : dual.gpt };
}
