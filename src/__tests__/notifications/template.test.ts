import { describe, it, expect } from "vitest";
import {
  KNOWN_TEMPLATE_VARS,
  renderTemplate,
  validateTemplate,
} from "../../notifications/template.js";

describe("renderTemplate", () => {
  it("substitutes simple {{var}}", () => {
    const out = renderTemplate("hi {{name}}!", { name: "world" } as never);
    expect(out).toBe("hi world!");
  });

  it("renders missing variables as empty string without throwing", () => {
    const out = renderTemplate("a={{missing}} b={{also_missing}}", {} as never);
    expect(out).toBe("a= b=");
  });

  it("renders {{#if}} truthy branch", () => {
    const out = renderTemplate("x{{#if flag}}YES{{/if}}z", { flag: "go" } as never);
    expect(out).toBe("xYESz");
  });

  it("renders {{#if}} falsy branch as empty", () => {
    const out = renderTemplate("x{{#if flag}}YES{{/if}}z", {} as never);
    expect(out).toBe("xz");
    // explicit false and "" are falsy
    expect(renderTemplate("{{#if a}}X{{/if}}", { a: "" } as never)).toBe("");
    expect(renderTemplate("{{#if a}}X{{/if}}", { a: false } as never)).toBe("");
  });

  it("computes duration (smart format)", () => {
    expect(renderTemplate("{{duration}}", { duration: 45_000 } as never)).toBe("45s");
    expect(renderTemplate("{{duration}}", { duration: 65_000 } as never)).toBe("1m 5s");
    expect(renderTemplate("{{duration}}", { duration: 3_900_000 } as never)).toBe("1h 5m");
  });

  it("computes projectDisplay fallback chain", () => {
    expect(renderTemplate("{{projectDisplay}}", { projectName: "p" } as never)).toBe("p");
    expect(
      renderTemplate("{{projectDisplay}}", { projectPath: "/a/b/proj" } as never),
    ).toBe("proj");
    expect(renderTemplate("{{projectDisplay}}", {} as never)).toBe("(unknown project)");
  });

  it("computes reasonDisplay fallback to unknown", () => {
    expect(renderTemplate("{{reasonDisplay}}", {} as never)).toBe("unknown");
    expect(renderTemplate("{{reasonDisplay}}", { reason: "done" } as never)).toBe("done");
  });

  it("renders tmuxTailBlock with code fence when tail present", () => {
    const out = renderTemplate("{{tmuxTailBlock}}", { tmuxTail: "hello" } as never);
    expect(out).toBe("```\nhello\n```");
    expect(renderTemplate("{{tmuxTailBlock}}", {} as never)).toBe("");
  });

  it("expands variables inside {{#if}} body", () => {
    const out = renderTemplate(
      "{{#if reason}}Reason: {{reason}}{{/if}}",
      { reason: "completed" } as never,
    );
    expect(out).toBe("Reason: completed");
  });
});

describe("validateTemplate", () => {
  it("returns empty array for templates using only known vars", () => {
    const tpl = "{{projectDisplay}} {{duration}} {{#if reason}}{{reason}}{{/if}}";
    expect(validateTemplate(tpl, KNOWN_TEMPLATE_VARS)).toEqual([]);
  });

  it("detects unknown variables", () => {
    const tpl = "hi {{nope}} and {{also_nope}} and {{duration}}";
    const unknown = validateTemplate(tpl, KNOWN_TEMPLATE_VARS);
    expect(unknown).toContain("nope");
    expect(unknown).toContain("also_nope");
    expect(unknown).not.toContain("duration");
  });

  it("detects unknown var inside if body", () => {
    const tpl = "{{#if flag}}{{whatevs}}{{/if}}";
    const unknown = validateTemplate(tpl, KNOWN_TEMPLATE_VARS);
    expect(unknown).toContain("flag");
    expect(unknown).toContain("whatevs");
  });
});
