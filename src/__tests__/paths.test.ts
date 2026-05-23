import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { resolvePaths } from "../runtime/paths.js";

describe("resolvePaths", () => {
  const prevHome = process.env.OMCP_HOME;
  afterEach(() => {
    if (prevHome === undefined) delete process.env.OMCP_HOME;
    else process.env.OMCP_HOME = prevHome;
  });

  it("uses OMCP_HOME when set", () => {
    const paths = resolvePaths({ OMCP_HOME: "/custom/home" });
    expect(paths.copilotHome).toBe("/custom/home");
    expect(paths.copilotConfig).toMatch(/config\.json$/);
    expect(paths.copilotSettings).toMatch(/settings\.json$/);
    expect(paths.omcpPluginDir).toContain("installed-plugins");
    expect(paths.omcpPluginDir).toContain("oh-my-copilot");
  });

  it("derives all derived paths under copilotHome", () => {
    const paths = resolvePaths({ OMCP_HOME: "/h" });
    expect(paths.installedPlugins).toBe(join("/h", "installed-plugins"));
    expect(paths.omcpMarketplaceFile).toContain("oh-my-copilot.json");
    expect(paths.omcpPluginDir).toBe(
      join("/h", "installed-plugins", "oh-my-copilot", "oh-my-copilot"),
    );
  });
});
