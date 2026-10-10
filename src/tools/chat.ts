/**
 * Chat Controller — /chat/*
 */

import { z } from "zod";
import type { ToolDef, ToolGroup } from "../types.js";
import { ToolInputError } from "../client.js";
import { instanceField, numberField, messageKey, basicMessageKey } from "../schemas/common.js";
import { postBody, splitInstance } from "./helpers.js";

const pageShape = {
  page: z.number().int().positive().optional().describe("1-based page number (default 1)."),
  offset: z.number().int().positive().optional().describe("Page size (default 50)."),
};

/**
 * findMessages matches `key.remoteJid = X OR key.remoteJidAlt = Y` (only for non-empty keys), and keys
 * are stored as Baileys delivers them (an @lid chat keeps remoteJid=<lid>, remoteJidAlt=<phone>).
 * Sending remoteJid as remoteJidAlt too makes the phone JID match both forms; an @lid JID still misses
 * messages sent through the API (stored under the phone JID without remoteJidAlt). A caller's non-empty
 * remoteJidAlt is kept; an empty one, which Evolution ignores, gets the default.
 */
function withAlternateJid(where: unknown): unknown {
  if (!where || typeof where !== "object") return where;
  const filters = where as { key?: Record<string, unknown> };
  const key = filters.key;
  if (!key?.remoteJid || key.remoteJidAlt) return where;
  return { ...filters, key: { ...key, remoteJidAlt: key.remoteJid } };
}

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
      "blocks for that long (the MCP extends its HTTP timeout by the delay) and then sends 'paused'.",
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
        .describe("Filters. Omit to list all contacts, paginated."),
      page: z.number().int().positive().optional().describe("1-based page number (default 1)."),
      // Evolution has no default page size here (it returns every contact) and a page without
      // offset makes it compute skip = NaN (HTTP 500), so offset is always sent.
      offset: z
        .number()
        .int()
        .positive()
        .default(50)
        .describe("Page size (default 50 in this tool; Evolution itself would return every contact)."),
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
              remoteJid: z
                .string()
                .optional()
                .describe(
                  "Chat JID. Prefer the phone JID (…@s.whatsapp.net): the MCP also sends it as remoteJidAlt, so " +
                    "received messages stored under the chat's @lid form match too. Messages stored without " +
                    "remoteJidAlt (sent through the API, or imported by history sync) match only the JID they were " +
                    "stored under: for a complete history also query the @lid JID.",
                ),
              remoteJidAlt: z
                .string()
                .optional()
                .describe(
                  "Matched against the stored key.remoteJidAlt, which holds the OTHER form of the chat JID (the " +
                    "phone JID on @lid-stored messages). Leave it unset: it defaults to remoteJid, which with the " +
                    "phone JID also matches received messages stored under the @lid form. Setting it to the chat's " +
                    "other form drops the messages stored under that form.",
                ),
              fromMe: z.boolean().optional().describe("Only true is applied (false is ignored by the server)."),
              participant: z.string().optional().describe("Group sender JID."),
            })
            .optional()
            .describe("Message key filters."),
          id: z.string().optional().describe("Internal database id."),
          messageType: z
            .string()
            .optional()
            .describe("e.g. conversation (every text message), imageMessage, audioMessage, documentMessage."),
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
    handler: async (client, args) => {
      const { inst, rest } = splitInstance(client, args);
      return client.post(`/chat/findMessages/${inst}`, { body: { ...rest, where: withAlternateJid(rest.where) } });
    },
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
    description:
      "Edit a previously sent text message (or an image/video caption). The edit goes to key.remoteJid: " +
      "the JID the message is stored under (from the send response or evolution_chat_find_messages).",
    inputSchema: z.object({
      instance: instanceField,
      number: z
        .string()
        .optional()
        .describe("Not needed: key.remoteJid is sent as number. Used only when key.remoteJid is empty."),
      key: basicMessageKey.describe("Key of the message to edit."),
      text: z.string().describe("New text content."),
    }),
    handler: async (client, args) => {
      const { inst, rest } = splitInstance(client, args);
      // Evolution compares createJid(number) with the stored key.remoteJid ('RemoteJid does not match'
      // otherwise); createJid drops the MX/AR mobile digit of 13-digit numbers, so send the JID itself.
      const number = (rest.key as { remoteJid?: string }).remoteJid || (rest.number as string | undefined);
      if (!number) {
        throw new ToolInputError("key.remoteJid is empty: pass the chat JID of the message to edit.");
      }
      return client.post(`/chat/updateMessage/${inst}`, { body: { ...rest, number } });
    },
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
