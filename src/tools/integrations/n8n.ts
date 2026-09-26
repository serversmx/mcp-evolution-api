/**
 * n8n integration — /n8n/*
 */

import { z } from "zod";
import { makeBotGroup, SETTINGS_REQUIRED_FULL } from "./botFactory.js";

export const n8nGroup = makeBotGroup({
  group: "n8n",
  base: "n8n",
  label: "n8n",
  envFlag: "N8N_ENABLED",
  specificShape: {
    webhookUrl: z.string().describe("n8n Webhook/Chat Trigger URL that Evolution POSTs each message to."),
    basicAuthUser: z.string().optional().describe("Basic auth user for the n8n webhook."),
    basicAuthPass: z
      .string()
      .optional()
      .describe("Basic auth password (sent only when basicAuthUser is also set)."),
  },
  requiredSpecific: ["webhookUrl"],
  settingsRequired: SETTINGS_REQUIRED_FULL,
});
