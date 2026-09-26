/**
 * Evolution Bot integration — /evolutionBot/*
 */

import { z } from "zod";
import { makeBotGroup, SETTINGS_REQUIRED_FULL } from "./botFactory.js";

export const evolutionBotGroup = makeBotGroup({
  group: "evolutionbot",
  base: "evolutionBot",
  label: "Evolution Bot",
  specificShape: {
    apiUrl: z.string().describe("Your bot endpoint; Evolution POSTs each message and sends back the reply."),
    apiKey: z.string().optional().describe("Sent as Bearer token to apiUrl."),
  },
  requiredSpecific: ["apiUrl"],
  settingsRequired: SETTINGS_REQUIRED_FULL,
});
