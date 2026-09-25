/**
 * Profile Settings Controller — /chat/* (profile-related endpoints)
 */

import { z } from "zod";
import type { ToolDef, ToolGroup } from "../types.js";
import { ToolInputError } from "../client.js";
import { instanceField, numberField } from "../schemas/common.js";
import { compact, missingKeys, pickDefined, postBody } from "./helpers.js";

const PRIVACY_FIELDS = ["readreceipts", "profile", "status", "online", "last", "groupadd"] as const;
const audience = ["all", "contacts", "contact_blacklist", "none"] as const;

const tools: ToolDef[] = [
  {
    name: "evolution_profile_fetch_business",
    description: "Fetch the business profile of a number, or the instance's own profile when omitted.",
    inputSchema: z.object({ instance: instanceField, number: numberField.optional() }),
    handler: postBody("/chat/fetchBusinessProfile"),
  },
  {
    name: "evolution_profile_fetch",
    description: "Fetch the profile (name, status, picture) of a number. Omit number for the instance's own profile.",
    inputSchema: z.object({ instance: instanceField, number: numberField.optional() }),
    handler: postBody("/chat/fetchProfile"),
  },
  {
    name: "evolution_profile_update_name",
    description: "Update the instance's own profile name.",
    inputSchema: z.object({ instance: instanceField, name: z.string().min(1).describe("New profile name.") }),
    handler: postBody("/chat/updateProfileName"),
  },
  {
    name: "evolution_profile_update_status",
    description: "Update the instance's own profile status/about text.",
    inputSchema: z.object({
      instance: instanceField,
      status: z.string().min(1).describe("New status text."),
    }),
    handler: postBody("/chat/updateProfileStatus"),
  },
  {
    name: "evolution_profile_update_picture",
    description: "Update the instance's own profile picture from an image URL or raw base64.",
    inputSchema: z.object({
      instance: instanceField,
      picture: z
        .string()
        .describe("Image URL or RAW base64 (no 'data:...;base64,' prefix)."),
    }),
    handler: postBody("/chat/updateProfilePicture"),
  },
  {
    name: "evolution_profile_remove_picture",
    description: "Remove the instance's own profile picture.",
    inputSchema: z.object({ instance: instanceField }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.delete(`/chat/removeProfilePicture/${inst}`);
    },
  },
  {
    name: "evolution_profile_fetch_privacy",
    description: "Fetch the instance's privacy settings.",
    inputSchema: z.object({ instance: instanceField }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.get(`/chat/fetchPrivacySettings/${inst}`);
    },
  },
  {
    name: "evolution_profile_update_privacy",
    description:
      "Update the instance's privacy settings. Partial updates are safe: the API requires all six " +
      "fields, so the current values are read first and only the fields you pass are changed.",
    inputSchema: z.object({
      instance: instanceField,
      readreceipts: z.enum(["all", "none"]).optional().describe("Read receipts."),
      profile: z.enum(audience).optional().describe("Profile photo visibility."),
      status: z.enum(audience).optional().describe("Status visibility."),
      online: z.enum(["all", "match_last_seen"]).optional().describe("Online visibility."),
      last: z.enum(audience).optional().describe("Last seen visibility."),
      groupadd: z.enum(audience).optional().describe("Who can add the instance to groups."),
    }),
    handler: async (client, args) => {
      const { instance, ...changes } = args;
      const inst = client.resolveInstance(instance as string | undefined);
      let body = compact(changes);
      if (missingKeys(body, PRIVACY_FIELDS).length > 0) {
        const current = await client.get(`/chat/fetchPrivacySettings/${inst}`);
        body = { ...pickDefined(current, PRIVACY_FIELDS), ...body };
        const missing = missingKeys(body, PRIVACY_FIELDS);
        if (missing.length > 0) {
          throw new ToolInputError(
            `Could not read the current privacy settings for: ${missing.join(", ")}. Pass all six fields.`,
          );
        }
      }
      return client.post(`/chat/updatePrivacySettings/${inst}`, { body });
    },
  },
];

export const profileGroup: ToolGroup = {
  group: "profile",
  core: true,
  label: "Profile settings",
  tools,
};
