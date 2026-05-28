// RP-10 drift-prevention: assert skills/team/SKILL.md retains F10/F14/F15 omc-canonical sections.
//
// VERIFY-MATCHES-OMC finding (per §2.D4a verify-before-refactor doctrine):
//   All three sections were present and correctly retargeted at baseline eb9f37e.
//   The plan's "gap" verdict was a planning error -- empirical grep against eb9f37e confirms:
//     F10 (Outbox Auto-Ingestion)  -- our line 648 matches omc canonical lines 657-715
//     F14 (Idempotent Recovery)    -- our line 795 matches omc canonical lines 798-808
//     F15 (When to Route Where)    -- our line 610 matches omc canonical lines 619-630
//
// These drift-prevention tests fail loudly if a future edit removes any omc-canonical section.
//
// omc source: oh-my-claudecode@4.9.3 skills/team/SKILL.md

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const SKILL_PATH = resolve(__dirname, "..", "..", "skills", "team", "SKILL.md");

describe("team SKILL.md RP-10 drift prevention vs omc canonical (F10/F14/F15)", () => {
  let body: string;

  beforeAll(() => {
    body = readFileSync(SKILL_PATH, "utf8");
  });

  // F10: Outbox Auto-Ingestion (omc canonical lines 657-715)
  describe("F10: Monitor Enhancement: Outbox Auto-Ingestion (omc lines 657-715)", () => {
    it("contains Outbox Auto-Ingestion section heading", () => {
      expect(
        body,
        "F10: 'Monitor Enhancement: Outbox Auto-Ingestion' section missing from skills/team/SKILL.md (omc canonical line 657)",
      ).toMatch(/## Monitor Enhancement: Outbox Auto-Ingestion/);
    });

    it("contains readNewOutboxMessages function (omc canonical line 663)", () => {
      expect(
        body,
        "F10: readNewOutboxMessages function missing from skills/team/SKILL.md (omc canonical line 663)",
      ).toMatch(/readNewOutboxMessages/);
    });

    it("contains readAllTeamOutboxMessages function (omc canonical line 665)", () => {
      expect(
        body,
        "F10: readAllTeamOutboxMessages function missing from skills/team/SKILL.md (omc canonical line 665)",
      ).toMatch(/readAllTeamOutboxMessages/);
    });

    it("contains resetOutboxCursor function (omc canonical line 667)", () => {
      expect(
        body,
        "F10: resetOutboxCursor function missing from skills/team/SKILL.md (omc canonical line 667)",
      ).toMatch(/resetOutboxCursor/);
    });

    it("contains getTeamStatus monitor phase usage (omc canonical line 669)", () => {
      expect(
        body,
        "F10: getTeamStatus() monitor phase section missing from skills/team/SKILL.md (omc canonical line 669)",
      ).toMatch(/getTeamStatus/);
    });

    it("contains event-based actions table (omc canonical lines 704-714)", () => {
      expect(
        body,
        "F10: event-based actions table missing from skills/team/SKILL.md (omc canonical lines 704-714)",
      ).toMatch(/Event-Based Actions from Outbox Messages/i);
      expect(body, "F10: task_complete event missing").toMatch(/task_complete/);
      expect(body, "F10: task_failed event missing").toMatch(/task_failed/);
      expect(body, "F10: shutdown_ack event missing").toMatch(/shutdown_ack/);
    });
  });

  // F14: Idempotent Recovery (omc canonical lines 798-808)
  describe("F14: Idempotent Recovery (omc lines 798-808)", () => {
    it("contains Idempotent Recovery section heading", () => {
      expect(
        body,
        "F14: 'Idempotent Recovery' section missing from skills/team/SKILL.md (omc canonical line 798)",
      ).toMatch(/## Idempotent Recovery/);
    });

    it("contains teams directory check step (omc canonical line 801)", () => {
      expect(
        body,
        "F14: teams directory check step missing from skills/team/SKILL.md (omc canonical line 801)",
      ).toMatch(/teams.*task slug|task slug.*teams/i);
    });

    it("contains config.json member discovery step (omc canonical line 802)", () => {
      expect(
        body,
        "F14: config.json member discovery step missing from skills/team/SKILL.md (omc canonical line 802)",
      ).toMatch(/config\.json.*members|members.*config\.json/i);
    });

    it("contains resume monitor mode step (omc canonical line 803)", () => {
      expect(
        body,
        "F14: resume monitor mode step missing from skills/team/SKILL.md (omc canonical line 803)",
      ).toMatch(/Resume monitor mode/i);
    });

    it("contains duplicate teams prevention note (omc canonical line 808)", () => {
      expect(
        body,
        "F14: duplicate teams prevention note missing from skills/team/SKILL.md (omc canonical line 808)",
      ).toMatch(/prevents duplicate teams/i);
    });
  });

  // F15: hybrid-route table / When to Route Where (omc canonical lines 619-630)
  describe("F15: When to Route Where hybrid-route table (omc lines 619-630)", () => {
    it("contains When to Route Where section heading", () => {
      expect(
        body,
        "F15: 'When to Route Where' section missing from skills/team/SKILL.md (omc canonical line 619)",
      ).toMatch(/### When to Route Where/);
    });

    it("contains routing table with iterative multi-step row (omc canonical line 623)", () => {
      expect(
        body,
        "F15: iterative multi-step work routing row missing (omc canonical line 623)",
      ).toMatch(/Iterative multi-step work/i);
    });

    it("contains routing table with CLI worker entries (omc canonical lines 624-628)", () => {
      expect(
        body,
        "F15: code review / security audit routing row missing (omc canonical line 624)",
      ).toMatch(/Code review.*security audit|security audit.*code review/i);
      expect(
        body,
        "F15: refactoring routing row missing (omc canonical line 626)",
      ).toMatch(/Refactoring.*well-scoped/i);
    });

    it("contains routing table with in-process teammate entries (omc canonical lines 629-630)", () => {
      expect(
        body,
        "F15: build/test iteration loops routing row missing (omc canonical line 629)",
      ).toMatch(/Build.*test iteration loops/i);
      expect(
        body,
        "F15: tasks needing team coordination routing row missing (omc canonical line 630)",
      ).toMatch(/Tasks needing team coordination/i);
    });

    it("contains cost-mode routing rule (omc canonical line 114, F15 cost-mode tier)", () => {
      expect(
        body,
        "F15: cost mode routing rule missing from skills/team/SKILL.md (omc canonical line 114)",
      ).toMatch(/Cost mode affects model tier/i);
    });
  });
});
