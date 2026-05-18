// `omcp notepad <subcommand>` — CLI surface for the notepad MCP tool.
// Mirrors omx's `omx notepad` verbs exactly (tool names as subcommands,
// with friendly aliases matching omx's mcp-parity aliases).
//
// Subcommands:
//   read                    Print all notepad sections as JSON.
//   write-priority <text>   Append text to the priority section.
//   write-working  <text>   Append text to the working section.
//   write-manual   <text>   Append text to the manual section.
//   prune <section>         Clear a section (priority|working|manual).
//   stats                   Print per-section line counts.
//
// Path isolation: set OMCP_NOTEPAD_PATH to override the default .omcp/notepad.md.

import {
  notepadRead,
  notepadWriteSection,
  notepadPrune,
  notepadStats,
  type Section,
} from "../../runtime/notepad.js";

export function runNotepadCommand(args: string[]): void {
  const [sub, ...rest] = args;

  switch (sub) {
    case "read":
    case "notepad_read": {
      const np = notepadRead();
      console.log(JSON.stringify(np, null, 2));
      return;
    }

    case "write-priority":
    case "notepad_write_priority": {
      const text = rest.join(" ");
      if (!text) {
        console.error("omcp notepad write-priority: <text> is required");
        process.exitCode = 2;
        return;
      }
      const r = notepadWriteSection("priority", text);
      console.log(JSON.stringify(r));
      return;
    }

    case "write-working":
    case "notepad_write_working": {
      const text = rest.join(" ");
      if (!text) {
        console.error("omcp notepad write-working: <text> is required");
        process.exitCode = 2;
        return;
      }
      const r = notepadWriteSection("working", text);
      console.log(JSON.stringify(r));
      return;
    }

    case "write-manual":
    case "notepad_write_manual": {
      const text = rest.join(" ");
      if (!text) {
        console.error("omcp notepad write-manual: <text> is required");
        process.exitCode = 2;
        return;
      }
      const r = notepadWriteSection("manual", text);
      console.log(JSON.stringify(r));
      return;
    }

    case "prune":
    case "notepad_prune": {
      const section = rest[0] as Section | undefined;
      if (!section || !["priority", "working", "manual"].includes(section)) {
        console.error(
          "omcp notepad prune: <section> must be priority|working|manual",
        );
        process.exitCode = 2;
        return;
      }
      const r = notepadPrune(section);
      console.log(JSON.stringify(r));
      return;
    }

    case "stats":
    case "notepad_stats": {
      const r = notepadStats();
      console.log(JSON.stringify(r, null, 2));
      return;
    }

    default: {
      console.log(
        [
          "Usage: omcp notepad <subcommand> [args]",
          "",
          "Subcommands:",
          "  read                     Print all notepad sections as JSON",
          "  write-priority <text>    Append to priority section",
          "  write-working  <text>    Append to working section",
          "  write-manual   <text>    Append to manual section",
          "  prune <section>          Clear a section (priority|working|manual)",
          "  stats                    Per-section line counts",
        ].join("\n"),
      );
      if (sub && sub !== "--help" && sub !== "-h" && sub !== "help") {
        console.error(`\nomcp notepad: unknown subcommand '${sub}'`);
        process.exitCode = 2;
      }
    }
  }
}
