// `omcp project-memory <subcommand>` — CLI surface for the project-memory MCP tool.
// Mirrors omx's `omx project-memory` verbs exactly.
//
// Subcommands:
//   read                       Print the full project memory as JSON.
//   write <key> <value-json>   Set a key under .data (value parsed as JSON).
//   add-note <text>            Append a timestamped free-form note.
//   add-directive <text>       Append a timestamped behaviorally-binding directive.
//
// Path isolation: set OMCP_PROJECT_MEMORY to override the default .omcp/project-memory.json.

import {
  projectMemoryRead,
  projectMemoryWrite,
  projectMemoryAddNote,
  projectMemoryAddDirective,
} from "../../runtime/project-memory.js";

export function runProjectMemoryCommand(args: string[]): void {
  const [sub, ...rest] = args;

  switch (sub) {
    case "read":
    case "project_memory_read": {
      const m = projectMemoryRead();
      console.log(JSON.stringify(m, null, 2));
      return;
    }

    case "write":
    case "project_memory_write": {
      const [key, rawValue] = rest;
      if (!key || rawValue === undefined) {
        console.error("omcp project-memory write: <key> <value-json> are required");
        process.exitCode = 2;
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(rawValue);
      } catch {
        // treat as a plain string if JSON parse fails
        value = rawValue;
      }
      const r = projectMemoryWrite(key, value);
      console.log(JSON.stringify(r));
      return;
    }

    case "add-note":
    case "project_memory_add_note": {
      const text = rest.join(" ");
      if (!text) {
        console.error("omcp project-memory add-note: <text> is required");
        process.exitCode = 2;
        return;
      }
      const r = projectMemoryAddNote(text);
      console.log(JSON.stringify(r));
      return;
    }

    case "add-directive":
    case "project_memory_add_directive": {
      const text = rest.join(" ");
      if (!text) {
        console.error("omcp project-memory add-directive: <text> is required");
        process.exitCode = 2;
        return;
      }
      const r = projectMemoryAddDirective(text);
      console.log(JSON.stringify(r));
      return;
    }

    default: {
      console.log(
        [
          "Usage: omcp project-memory <subcommand> [args]",
          "",
          "Subcommands:",
          "  read                       Print the full project memory as JSON",
          "  write <key> <value-json>   Set a key under .data",
          "  add-note <text>            Append a timestamped note",
          "  add-directive <text>       Append a behaviorally-binding directive",
        ].join("\n"),
      );
      if (sub && sub !== "--help" && sub !== "-h" && sub !== "help") {
        console.error(`\nomcp project-memory: unknown subcommand '${sub}'`);
        process.exitCode = 2;
      }
    }
  }
}
