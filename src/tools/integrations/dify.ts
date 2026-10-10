/**
 * Dify integration — /dify/*
 */

import { z } from "zod";
import { makeBotGroup, SETTINGS_REQUIRED_FULL } from "./botFactory.js";

export const difyGroup = makeBotGroup({
  group: "dify",
  base: "dify",
  label: "Dify",
  envFlag: "DIFY_ENABLED",
  specificShape: {
    botType: z
      .enum(["chatBot", "textGenerator", "agent", "workflow"])
      .describe(
        "Dify app type. 'workflow' is accepted but never processed by Evolution API 2.3.7–develop: " +
          "workflow bots never reply (use chatBot, agent or textGenerator).",
      ),
    apiUrl: z.string().optional().describe("Dify API base URL, e.g. https://api.dify.ai/v1."),
    apiKey: z.string().optional().describe("Dify app API key."),
  },
  requiredSpecific: ["botType"],
  settingsRequired: SETTINGS_REQUIRED_FULL,
  fallbackIgnored: true,
});
