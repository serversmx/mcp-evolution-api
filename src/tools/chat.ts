/**
 * Chat Controller — /chat/*
 */

import { z } from "zod";
import type { ToolDef, ToolGroup } from "../types.js";
import { instanceField, numberField, messageKey, basicMessageKey } from "../schemas/common.js";
import { postBody } from "./helpers.js";

const pageShape = {
  page: z.number().int().positive().optional().describe("1-based page number (default 1)."),
  offset: z.number().int().positive().optional().describe("Page size (default 50)."),
};

const lastMessageField = z.object({
  key: messageKey,
  messageTimestamp: z.number().int().optional().describe("Unix timestamp in seconds of the last message."),
}).describe("Last message in the chat; key.remoteJid selects the chat.");

const tools: ToolDef[] = [
  {
    name: "evolution_chat_check_numbers",
    description: "Check which numbers are registered on WhatsApp.",
    inputSchema: z.object({
      instance: instanceField,
      numbers: z.array(z.string()).min(1).describe("Phone numbers to check (with country code)."),
    }),
    handler: postBody("/chat/whatsappNumbers"),
  },
  {
    name: "evolution_chat_mark_read",
    description:
      "Mark one or more messages as read. WARNING: Evolution API 2.3.7 silently drops keys whose " +
      "remoteJid is an @lid JID and still reports success; use the phone JID (…@s.whatsapp.net) on 2.3.7.",
    inputSchema: z.object({
      instance: instanceField,
      readMessages: z.array(basicMessageKey).min(1).describe("Message keys to mark as read."),
    }),
    handler: postBody("/chat/markMessageAsRead"),
  },
  {
    name: "evolution_chat_mark_played",
    description:
      "Mark voice notes (PTT) as played (blue microphone). Requires Evolution API 2.4+ (404 on 2.3.7). " +
      "@lid keys are skipped silently.",
    inputSchema: z.object({
      instance: instanceField,
      playedMessages: z.array(basicMessageKey).min(1).describe("Audio message keys to mark as played."),
    }),
    handler: postBody("/chat/markMessageAsPlayed"),
  },
  {
    name: "evolution_chat_mark_unread",
    description: "Mark a chat as unread.",
    inputSchema: z.object({
      instance: instanceField,
      chat: z.string().optional().describe("Optional chat JID; lastMessage.key.remoteJid takes precedence."),
      lastMessage: lastMessageField,
    }),
    handler: postBody("/chat/markChatUnread"),
  },
  {
    name: "evolution_chat_archive",
    description: "Archive or unarchive a chat. Supply the last message for compatibility with Evolution API 2.3.7.",
    inputSchema: z.object({
      instance: instanceField,
      chat: z.string().optional().describe("Optional chat JID; lastMessage.key.remoteJid takes precedence."),
      archive: z.boolean().describe("true to archive, false to unarchive."),
      lastMessage: lastMessageField,
    }),
    handler: postBody("/chat/archiveChat"),
  },
  {
    name: "evolution_chat_delete_message",
    description: "Delete a message for everyone.",
    inputSchema: z.object({
      instance: instanceField,
      id: z.string().describe("Message id."),
      remoteJid: z.string().describe("FULL chat JID (used verbatim; a bare number fails)."),
      fromMe: z.boolean().describe("true to revoke own messages; false = admin delete in groups."),
      participant: z.string().optional().describe("Participant JID (group messages)."),
    }),
    handler: async (client, args) => {
      const { instance, ...body } = args;
      const inst = client.resolveInstance(instance as string | undefined);
      return client.delete(`/chat/deleteMessageForEveryone/${inst}`, { body });
    },
  },
  {
    name: "evolution_chat_send_presence",
    description:
      "Show a presence indicator in a chat (composing/recording/paused) for `delay` ms; the request " +
      "blocks for that long and then sends 'paused'.",
    inputSchema: z.object({
      instance: instanceField,
      number: numberField,
      presence: z
        .enum(["composing", "recording", "paused", "available", "unavailable"])
        .describe("Presence to display."),
      delay: z
        .number()
        .int()
        .nonnegative()
        .describe("How long to show it, in ms (required by the API)."),
    }),
    handler: postBody("/chat/sendPresence"),
  },
  {
    name: "evolution_chat_update_block",
    description: "Block or unblock a contact.",
    inputSchema: z.object({
      instance: instanceField,
      number: numberField,
      status: z.enum(["block", "unblock"]).describe("Block action."),
    }),
    handler: postBody("/chat/updateBlockStatus"),
  },
  {
    name: "evolution_chat_profile_picture_url",
    description: "Get the profile picture URL of a number (null when hidden by privacy settings).",
    inputSchema: z.object({ instance: instanceField, number: numberField }),
    handler: postBody("/chat/fetchProfilePictureUrl"),
  },
  {
    name: "evolution_chat_media_base64",
    description:
      "Get the base64 content of a media message. Pass the full message (e.g. from a webhook) or just " +
      "{key:{id}} when the message is stored in the Evolution DB.",
    inputSchema: z.object({
      instance: instanceField,
      message: z
        .object({
          key: z
            .object({ id: z.string().describe("Message id.") })
            .passthrough()
            .describe("Message key ({id} is enough when the message is stored; extra key fields are forwarded)."),
          message: z
            .record(z.any())
            .optional()
            .describe("Proto content incl. mediaKey/directPath/url (e.g. {imageMessage:{...}})."),
        })
        .passthrough()
        .describe("The media message: the webhook `data` object as-is, or just {key:{id}}."),
      convertToMp4: z.boolean().optional().describe("Audio only: convert to audio/mp4."),
    }),
    handler: postBody("/chat/getBase64FromMediaMessage"),
  },
  {
    name: "evolution_chat_find_contacts",
    description:
      "Find stored contacts. Filter by JID with where.remoteJid (where.id is the internal database id, not the JID).",
    inputSchema: z.object({
      instance: instanceField,
      where: z
        .object({
          remoteJid: z
            .string()
            .optional()
            .describe("Contact JID, e.g. '5215550123@s.whatsapp.net' (THE JID filter)."),
          id: z.string().optional().describe("Internal database id (cuid) - NOT the JID."),
          pushName: z.string().optional().describe("Exact push name."),
        })
        .optional()
        .describe("Filters. Omit to list all contacts."),
      ...pageShape,
    }),
    handler: async (client, args) => {
      const { instance, where, ...rest } = args;
      const inst = client.resolveInstance(instance as string | undefined);
      return client.post(`/chat/findContacts/${inst}`, { body: { where: where ?? {}, ...rest } });
    },
  },
  {
    name: "evolution_chat_find_messages",
    description: "Find stored messages, optionally filtered by chat and paginated.",
    inputSchema: z.object({
      instance: instanceField,
      where: z
        .object({
          key: z
            .object({
              id: z.string().optional().describe("Message id."),
              remoteJid: z.string().optional().describe("Chat JID (also matches the alternate @lid/phone JID)."),
              remoteJidAlt: z.string().optional().describe("Alternate chat JID (@lid <-> phone)."),
              fromMe: z.boolean().optional().describe("Only true is applied (false is ignored by the server)."),
              participant: z.string().optional().describe("Group sender JID."),
            })
            .optional()
            .describe("Message key filters."),
          id: z.string().optional().describe("Internal database id."),
          messageType: z
            .string()
            .optional()
            .describe("e.g. conversation, extendedTextMessage, imageMessage, audioMessage."),
          source: z.string().optional().describe("android | ios | web | desktop | unknown."),
          messageTimestamp: z
            .object({
              gte: z.string().describe("Start date, e.g. 2026-01-01 (applied only together with lte)."),
              lte: z.string().describe("End date (applied only together with gte)."),
            })
            .optional()
            .describe("Date range."),
        })
        .optional()
        .describe("Filters, e.g. { key: { remoteJid: '5215550123@s.whatsapp.net' } }."),
      ...pageShape,
    }),
    handler: postBody("/chat/findMessages"),
  },
  {
    name: "evolution_chat_find_status",
    description:
      "Find delivery/read status updates of messages (MessageUpdate rows: PENDING, SERVER_ACK, " +
      "DELIVERY_ACK, READ, PLAYED). NOT WhatsApp Status stories. Only where.remoteJid and where.id " +
      "are applied as filters.",
    inputSchema: z.object({
      instance: instanceField,
      where: z
        .object({
          remoteJid: z.string().optional().describe("Chat JID."),
          id: z.string().optional().describe("WhatsApp message id (key.id) whose updates you want."),
        })
        .optional()
        .describe("Filters."),
      ...pageShape,
    }),
    handler: async (client, args) => {
      const { instance, where, ...rest } = args;
      const inst = client.resolveInstance(instance as string | undefined);
      return client.post(`/chat/findStatusMessage/${inst}`, { body: { where: where ?? {}, ...rest } });
    },
  },
  {
    name: "evolution_chat_find_chats",
    description:
      "List chats for the instance (built from stored messages), newest first, paginated with take/skip.",
    inputSchema: z.object({
      instance: instanceField,
      where: z
        .object({
          remoteJid: z.string().optional().describe("Chat JID."),
          messageTimestamp: z
            .object({
              gte: z.string().describe("Start date (applied only together with lte)."),
              lte: z.string().describe("End date (applied only together with gte)."),
            })
            .optional()
            .describe("Last-message date range."),
        })
        .optional()
        .describe("Optional filters."),
      take: z.number().int().positive().optional().describe("Max chats to return (LIMIT)."),
      skip: z.number().int().nonnegative().optional().describe("Chats to skip (OFFSET)."),
    }),
    handler: postBody("/chat/findChats"),
  },
  {
    name: "evolution_chat_find_chat_by_jid",
    description: "Get a single stored chat by its exact JID (null when not found).",
    inputSchema: z.object({
      instance: instanceField,
      remoteJid: z.string().describe("Exact chat JID, e.g. 5215550123@s.whatsapp.net (no normalization)."),
    }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.get(`/chat/findChatByRemoteJid/${inst}`, {
        query: { remoteJid: args.remoteJid as string },
      });
    },
  },
  {
    name: "evolution_chat_update_message",
    description: "Edit a previously sent text message (or an image/video caption).",
    inputSchema: z.object({
      instance: instanceField,
      number: numberField,
      key: basicMessageKey.describe("Key of the message to edit."),
      text: z.string().describe("New text content."),
    }),
    handler: postBody("/chat/updateMessage"),
  },
  {
    name: "evolution_chat_get_poll_vote",
    description:
      "Get the decrypted results of a poll sent by this instance. Requires Evolution API 2.4+ (404 on 2.3.7); " +
      "the poll creation message must be stored in the DB.",
    inputSchema: z.object({
      instance: instanceField,
      remoteJid: z.string().describe("Chat JID where the poll was sent."),
      message: z
        .object({
          key: z.object({ id: z.string().describe("Id of the poll creation message.") }),
        })
        .describe("Poll creation message reference."),
    }),
    handler: postBody("/chat/getPollVote"),
  },
  {
    name: "evolution_chat_find_channels",
    description:
      "List WhatsApp channels (newsletters) seen in stored messages. Requires Evolution API 2.4+ (404 on 2.3.7).",
    inputSchema: z.object({
      instance: instanceField,
      page: z.number().int().positive().optional().describe("Page (default 1)."),
      limit: z.number().int().positive().optional().describe("Page size (default 50)."),
    }),
    handler: postBody("/chat/findChannels"),
  },
];

export const chatGroup: ToolGroup = {
  group: "chat",
  core: true,
  label: "Chats and contacts",
  tools,
};
