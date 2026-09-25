/**
 * Group Controller — /group/*
 *
 * Most endpoints target a specific group via the `groupJid` query parameter.
 */

import { z } from "zod";
import type { ToolDef, ToolGroup } from "../types.js";
import { instanceField } from "../schemas/common.js";

const groupJidField = z.string().describe("Group JID, e.g. 1203630xxxxxxxxx@g.us");

const tools: ToolDef[] = [
  {
    name: "evolution_group_create",
    description: "Create a new group.",
    inputSchema: z.object({
      instance: instanceField,
      subject: z.string().describe("Group name."),
      description: z.string().optional().describe("Group description."),
      participants: z
        .array(z.string())
        .min(1)
        .describe("Participant numbers (digits with country code). Numbers not on WhatsApp are dropped."),
      promoteParticipants: z.boolean().optional().describe("Promote all participants to admin."),
    }),
    handler: async (client, args) => {
      const { instance, ...body } = args;
      const inst = client.resolveInstance(instance as string | undefined);
      return client.post(`/group/create/${inst}`, { body });
    },
  },
  {
    name: "evolution_group_update_picture",
    description: "Update a group's picture from an image URL or raw base64.",
    inputSchema: z.object({
      instance: instanceField,
      groupJid: groupJidField,
      image: z.string().describe("Image URL or RAW base64 (no 'data:...;base64,' prefix)."),
    }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.post(`/group/updateGroupPicture/${inst}`, {
        query: { groupJid: args.groupJid as string },
        body: { image: args.image },
      });
    },
  },
  {
    name: "evolution_group_update_subject",
    description: "Update a group's name/subject.",
    inputSchema: z.object({
      instance: instanceField,
      groupJid: groupJidField,
      subject: z.string().describe("New group name."),
    }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.post(`/group/updateGroupSubject/${inst}`, {
        query: { groupJid: args.groupJid as string },
        body: { subject: args.subject },
      });
    },
  },
  {
    name: "evolution_group_update_description",
    description: "Update a group's description.",
    inputSchema: z.object({
      instance: instanceField,
      groupJid: groupJidField,
      description: z.string().describe("New description."),
    }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.post(`/group/updateGroupDescription/${inst}`, {
        query: { groupJid: args.groupJid as string },
        body: { description: args.description },
      });
    },
  },
  {
    name: "evolution_group_invite_code",
    description: "Get the invite code/link of a group.",
    inputSchema: z.object({ instance: instanceField, groupJid: groupJidField }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.get(`/group/inviteCode/${inst}`, { query: { groupJid: args.groupJid as string } });
    },
  },
  {
    name: "evolution_group_revoke_invite",
    description: "Revoke (regenerate) a group's invite code.",
    inputSchema: z.object({ instance: instanceField, groupJid: groupJidField }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.post(`/group/revokeInviteCode/${inst}`, {
        query: { groupJid: args.groupJid as string },
      });
    },
  },
  {
    name: "evolution_group_accept_invite",
    description: "Join a group using an invite code (side effect: joins immediately; do not retry blindly).",
    inputSchema: z.object({
      instance: instanceField,
      inviteCode: z.string().describe("Invite code (the part after chat.whatsapp.com/)."),
    }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.get(`/group/acceptInviteCode/${inst}`, {
        query: { inviteCode: args.inviteCode as string },
      });
    },
  },
  {
    name: "evolution_group_invite_info",
    description: "Get group info from an invite code without joining.",
    inputSchema: z.object({
      instance: instanceField,
      inviteCode: z.string().describe("Invite code."),
    }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.get(`/group/inviteInfo/${inst}`, {
        query: { inviteCode: args.inviteCode as string },
      });
    },
  },
  {
    name: "evolution_group_send_invite",
    description: "Send a group invite link to one or more numbers (one text message per number).",
    inputSchema: z.object({
      instance: instanceField,
      groupJid: groupJidField.describe("FULL group JID ending in @g.us (sent in the body, not normalized)."),
      description: z.string().describe("Invitation message."),
      numbers: z.array(z.string()).min(1).describe("Numbers to invite."),
    }),
    handler: async (client, args) => {
      const { instance, ...body } = args;
      const inst = client.resolveInstance(instance as string | undefined);
      return client.post(`/group/sendInvite/${inst}`, { body });
    },
  },
  {
    name: "evolution_group_find_info",
    description: "Get information about a specific group.",
    inputSchema: z.object({ instance: instanceField, groupJid: groupJidField }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.get(`/group/findGroupInfos/${inst}`, {
        query: { groupJid: args.groupJid as string },
      });
    },
  },
  {
    name: "evolution_group_fetch_all",
    description: "List all groups the instance belongs to.",
    inputSchema: z.object({
      instance: instanceField,
      getParticipants: z.boolean().optional().describe("Include participant lists."),
    }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.get(`/group/fetchAllGroups/${inst}`, {
        query: { getParticipants: (args.getParticipants as boolean | undefined) ?? false },
      });
    },
  },
  {
    name: "evolution_group_participants",
    description: "List the participants of a group.",
    inputSchema: z.object({ instance: instanceField, groupJid: groupJidField }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.get(`/group/participants/${inst}`, {
        query: { groupJid: args.groupJid as string },
      });
    },
  },
  {
    name: "evolution_group_update_participant",
    description: "Add, remove, promote, or demote group participants.",
    inputSchema: z.object({
      instance: instanceField,
      groupJid: groupJidField,
      action: z.enum(["add", "remove", "promote", "demote"]).describe("Action to perform."),
      participants: z.array(z.string()).min(1).describe("Participant numbers/JIDs."),
    }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.post(`/group/updateParticipant/${inst}`, {
        query: { groupJid: args.groupJid as string },
        body: { action: args.action, participants: args.participants },
      });
    },
  },
  {
    name: "evolution_group_update_setting",
    description: "Update group settings (who can message / edit info).",
    inputSchema: z.object({
      instance: instanceField,
      groupJid: groupJidField,
      action: z
        .enum(["announcement", "not_announcement", "locked", "unlocked"])
        .describe(
          "announcement: only admins send; not_announcement: all send; locked: only admins edit info; unlocked: all edit info.",
        ),
    }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.post(`/group/updateSetting/${inst}`, {
        query: { groupJid: args.groupJid as string },
        body: { action: args.action },
      });
    },
  },
  {
    name: "evolution_group_update_member_add_mode",
    description:
      "Set who can add members to a group (admins only or all members). Requires Evolution API 2.4+ (404 on 2.3.7).",
    inputSchema: z.object({
      instance: instanceField,
      groupJid: groupJidField,
      mode: z
        .enum(["admin_add", "all_member_add"])
        .describe("admin_add: only admins add members; all_member_add: every member can add."),
    }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.post(`/group/updateMemberAddMode/${inst}`, {
        query: { groupJid: args.groupJid as string },
        body: { mode: args.mode },
      });
    },
  },
  {
    name: "evolution_group_toggle_ephemeral",
    description: "Set disappearing messages timer for a group.",
    inputSchema: z.object({
      instance: instanceField,
      groupJid: groupJidField,
      expiration: z
        .union([z.literal(0), z.literal(86400), z.literal(604800), z.literal(7776000)])
        .describe("Seconds: 0 (off), 86400 (24h), 604800 (7d), 7776000 (90d)."),
    }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.post(`/group/toggleEphemeral/${inst}`, {
        query: { groupJid: args.groupJid as string },
        body: { expiration: args.expiration },
      });
    },
  },
  {
    name: "evolution_group_leave",
    description: "Leave a group.",
    inputSchema: z.object({ instance: instanceField, groupJid: groupJidField }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.delete(`/group/leaveGroup/${inst}`, {
        query: { groupJid: args.groupJid as string },
      });
    },
  },
];

export const groupGroup: ToolGroup = {
  group: "group",
  core: true,
  label: "Group management",
  tools,
};
