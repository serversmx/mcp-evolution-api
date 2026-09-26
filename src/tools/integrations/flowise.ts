/**
 * Flowise integration — /flowise/*
 */

import { z } from "zod";
import { makeBotGroup, SETTINGS_REQUIRED_FLOWISE } from "./botFactory.js";

export const flowiseGroup = makeBotGroup({
  group: "flowise",
  base: "flowise",
  label: "Flowise",
  envFlag: "FLOWISE_ENABLED",
  specificShape: {
    apiUrl: z.string().describe("Flowise prediction URL (…/api/v1/prediction/<chatflowId>)."),
    apiKey: z.string().optional().describe("Flowise API key."),
  },
  requiredSpecific: ["apiUrl"],
  settingsRequired: SETTINGS_REQUIRED_FLOWISE,
});
