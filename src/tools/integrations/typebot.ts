/**
 * Typebot integration — /typebot/*
 */

import { z } from "zod";
import type { ToolDef } from "../../types.js";
import { instanceField } from "../../schemas/common.js";
import { postBody } from "../helpers.js";
import { makeBotGroup, SETTINGS_REQUIRED_TYPEBOT } from "./botFactory.js";

const startTool: ToolDef = {
  name: "evolution_typebot_start",
  description: "Start a Typebot flow for a specific chat (emits TYPEBOT_START).",
  inputSchema: z.object({
    instance: instanceField,
    url: z.string().describe("Typebot base URL."),
    typebot: z.string().describe("Typebot public id."),
    remoteJid: z.string().describe("Target chat JID."),
    startSession: z
      .boolean()
      .optional()
      .describe("true: create/replace a persistent session; false: fire the flow once."),
    variables: z
      .array(z.object({ name: z.string(), value: z.string() }))
      .optional()
      .describe("Prefilled variables."),
  }),
  handler: postBody("/typebot/start"),
};

export const typebotGroup = makeBotGroup(
  {
    group: "typebot",
    base: "typebot",
    label: "Typebot",
    envFlag: "TYPEBOT_ENABLED",
    specificShape: {
      url: z.string().describe("Typebot viewer/API base URL."),
      typebot: z.string().describe("Typebot public id/slug."),
    },
    requiredSpecific: ["url", "typebot"],
    settingsRequired: SETTINGS_REQUIRED_TYPEBOT,
  },
  [startTool],
);
