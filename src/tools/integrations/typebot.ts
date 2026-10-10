/**
 * Typebot integration — /typebot/*
 */

import { z } from "zod";
import type { ToolDef } from "../../types.js";
import { ToolInputError } from "../../client.js";
import { instanceField } from "../../schemas/common.js";
import { splitInstance } from "../helpers.js";
import { isSavedSettings, makeBotGroup, SETTINGS_REQUIRED_TYPEBOT } from "./botFactory.js";

const startTool: ToolDef = {
  name: "evolution_typebot_start",
  description:
    "Start a Typebot flow for one chat. Requires saved Typebot settings (evolution_typebot_settings_set). " +
    "It deletes that chat's bot sessions of EVERY integration on this instance, creates an enabled " +
    "Typebot bot (no trigger) when none matches url+typebot, opens a session and emits TYPEBOT_CHANGE_STATUS.",
  inputSchema: z.object({
    instance: instanceField,
    url: z.string().describe("Typebot base URL."),
    typebot: z.string().describe("Typebot public id."),
    remoteJid: z.string().describe("Target chat JID."),
    startSession: z
      .boolean()
      .default(true)
      .describe(
        "Keep true (default). false is broken in Evolution API 2.3.7–develop: nothing is delivered, " +
          "yet the call succeeds and emits TYPEBOT_START.",
      ),
    variables: z
      .array(z.object({ name: z.string(), value: z.string() }))
      .optional()
      .describe("Prefilled variables."),
  }),
  handler: async (client, args) => {
    const { inst, rest } = splitInstance(client, args);
    // Both start modes crash with HTTP 500 (TypeError) when no TypebotSetting row exists.
    if (!isSavedSettings(await client.get(`/typebot/fetchSettings/${inst}`))) {
      throw new ToolInputError(
        "Typebot settings were never saved for this instance: run evolution_typebot_settings_set first " +
          "(Evolution fails with HTTP 500 without them).",
      );
    }
    return client.post(`/typebot/start/${inst}`, { body: rest });
  },
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
    sendsUnknownMessage: true,
  },
  [startTool],
);
