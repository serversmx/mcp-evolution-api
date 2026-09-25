/**
 * EvoAI integration — /evoai/*
 */

import { z } from "zod";
import { makeBotGroup, SETTINGS_REQUIRED_FULL } from "./botFactory.js";

export const evoaiGroup = makeBotGroup({
  group: "evoai",
  base: "evoai",
  label: "EvoAI",
  envFlag: "EVOAI_ENABLED",
  specificShape: {
    agentUrl: z.string().describe("EvoAI agent URL."),
    apiKey: z.string().optional().describe("EvoAI API key."),
  },
  requiredSpecific: ["agentUrl"],
  settingsRequired: SETTINGS_REQUIRED_FULL,
});
