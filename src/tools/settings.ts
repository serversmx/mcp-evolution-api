/**
 * Settings Controller — /settings/*
 */

import { z } from "zod";
import type { ToolDef, ToolGroup } from "../types.js";
import { instanceField } from "../schemas/common.js";
import { compact, pickDefined } from "./helpers.js";

/** The API requires ALL six booleans on every write. */
const REQUIRED_BOOLEANS = [
  "rejectCall",
  "groupsIgnore",
  "alwaysOnline",
  "readMessages",
  "readStatus",
  "syncFullHistory",
] as const;
const ALL_FIELDS = [...REQUIRED_BOOLEANS, "msgCall", "wavoipToken"] as const;

const tools: ToolDef[] = [
  {
    name: "evolution_settings_set",
    description:
      "Update behavior settings for an instance. Partial updates are safe: the current settings are " +
      "read first and only the fields you pass are changed (the API itself requires all six booleans). " +
      "If a WAVoIP token is stored, the server reconnects the socket on every write.",
    inputSchema: z.object({
      instance: instanceField,
      rejectCall: z.boolean().optional().describe("Automatically reject incoming calls."),
      msgCall: z.string().optional().describe("Message to send when rejecting a call."),
      groupsIgnore: z.boolean().optional().describe("Ignore group messages."),
      alwaysOnline: z.boolean().optional().describe("Keep the instance always online."),
      readMessages: z.boolean().optional().describe("Mark received messages as read."),
      readStatus: z.boolean().optional().describe("Mark statuses as read."),
      syncFullHistory: z.boolean().optional().describe("Sync full chat history on connect."),
      wavoipToken: z.string().optional().describe("WAVoIP token (calls)."),
    }),
    handler: async (client, args) => {
      const { instance, ...changes } = args;
      const inst = client.resolveInstance(instance as string | undefined);
      // Read-merge-write: omitted fields keep their current value. The server also resets its
      // in-memory msgCall/wavoipToken when they are omitted, so those are merged back too.
      const current = await client.get<Record<string, unknown> | null>(`/settings/find/${inst}`);
      const defaults = Object.fromEntries(REQUIRED_BOOLEANS.map((k) => [k, false]));
      const body = {
        ...defaults,
        ...pickDefined(current, ALL_FIELDS),
        ...compact(changes),
      };
      return client.post(`/settings/set/${inst}`, { body });
    },
  },
  {
    name: "evolution_settings_find",
    description: "Get the current settings of an instance (null when never set).",
    inputSchema: z.object({ instance: instanceField }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.get(`/settings/find/${inst}`);
    },
  },
];

export const settingsGroup: ToolGroup = {
  group: "settings",
  core: true,
  label: "Instance settings",
  tools,
};
