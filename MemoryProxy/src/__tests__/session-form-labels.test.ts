import { describe, expect, it } from "vitest";
import {
  ASSET_CONFIRM_FORM_TITLE,
  ASSET_CONFIRM_FORM_TITLE_ZH,
  ASSET_CONFIRM_NO,
  ASSET_CONFIRM_NO_ZH,
  ASSET_CONFIRM_YES,
  ASSET_CONFIRM_YES_ZH,
  TEAM_FORM_TITLE,
  TEAM_FORM_TITLE_ZH,
  containsFormTitle,
} from "../session/claude-code/form.js";
import { extractAssetConfirm } from "../session/claude-code/extractor.js";

// The proxy writes these labels into the form and later parses the user's answer, so
// the English labels it now shows and the legacy Chinese ones must both round-trip.
const answer = (label: string) => JSON.stringify({ answers: { "Link team assets?": label } });

describe("Claude Code session-init form labels", () => {
  it("accepts the English and the legacy Chinese asset-confirm answers", () => {
    expect(extractAssetConfirm(answer(ASSET_CONFIRM_YES))).toBe(true);
    expect(extractAssetConfirm(answer(ASSET_CONFIRM_NO))).toBe(false);
    expect(extractAssetConfirm(answer(ASSET_CONFIRM_YES_ZH))).toBe(true);
    expect(extractAssetConfirm(answer(ASSET_CONFIRM_NO_ZH))).toBe(false);
  });

  it("accepts short free-text answers in English", () => {
    expect(extractAssetConfirm(answer("yes"))).toBe(true);
    expect(extractAssetConfirm(answer("no"))).toBe(false);
  });

  it("recognises its own form title in history, English and legacy Chinese", () => {
    for (const t of [TEAM_FORM_TITLE, TEAM_FORM_TITLE_ZH, ASSET_CONFIRM_FORM_TITLE, ASSET_CONFIRM_FORM_TITLE_ZH]) {
      expect(containsFormTitle(`earlier turn: ${t}`)).toBe(true);
    }
    expect(containsFormTitle("an ordinary message")).toBe(false);
  });
});
