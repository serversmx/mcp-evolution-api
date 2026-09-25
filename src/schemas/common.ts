/**
 * Reusable zod fragments shared across tool definitions.
 */

import { z } from "zod";

/** Optional instance override; falls back to EVOLUTION_DEFAULT_INSTANCE. */
export const instanceField = z
  .string()
  .optional()
  .describe(
    "WhatsApp instance name. Optional if EVOLUTION_DEFAULT_INSTANCE is configured.",
  );

/** A recipient number or full JID (e.g. 5215550123 or 5215550123@s.whatsapp.net). */
export const numberField = z
  .string()
  .describe(
    "Recipient phone number (digits with country code) or full JID " +
      "(…@s.whatsapp.net, …@g.us, …@lid). Numbers not on WhatsApp are rejected with 400.",
  );

/** A WhatsApp message key, used to reference an existing message. */
export const messageKey = z
  .object({
    remoteJid: z.string().describe("Chat JID, e.g. 5215550123@s.whatsapp.net (full JID, used verbatim)."),
    fromMe: z.boolean().describe("Whether the referenced message was sent by this instance."),
    id: z.string().describe("Message ID."),
    participant: z
      .string()
      .optional()
      .describe("Participant JID (for group messages)."),
  })
  .describe("WhatsApp message key.");

/**
 * Message key without `participant`, for endpoints that only read id/fromMe/remoteJid
 * (markMessageAsRead/Played rebuild the key from those three fields; updateMessage).
 */
export const basicMessageKey = z
  .object({
    remoteJid: z.string().describe("Chat JID, e.g. 5215550123@s.whatsapp.net (full JID, used verbatim)."),
    fromMe: z.boolean().describe("Whether the message was sent by this instance."),
    id: z.string().describe("Message ID."),
  })
  .describe("WhatsApp message key.");

/** `delay` send option: blocks the HTTP request while "composing"/"recording" is shown. */
export const delayField = z
  .number()
  .int()
  .nonnegative()
  .optional()
  .describe(
    "Milliseconds of typing/recording presence before sending. The request blocks for this long.",
  );

/** Reply-to option. */
export const quotedField = z
  .object({
    key: messageKey.partial({ remoteJid: true, fromMe: true }).extend({
      id: z.string().min(1).describe("Message ID to quote; other key fields are optional."),
    }),
    message: z.record(z.any()).optional(),
  })
  .optional()
  .describe(
    "Message to quote/reply to. Without `message` the server loads the original from its DB; " +
      "if it is not stored the message is sent without the quote.",
  );

/** Mention options (groups only). */
export const mentionsShape = {
  mentionsEveryOne: z.boolean().optional().describe("Groups only: mention all participants."),
  mentioned: z
    .array(z.string())
    .optional()
    .describe("Groups only: numbers/JIDs to mention, e.g. ['5215550123@s.whatsapp.net']."),
};

/** Optional send-time options common to most message endpoints. */
export const sendOptionsShape = {
  delay: delayField,
  quoted: quotedField,
  ...mentionsShape,
};

/** Custom message id (idempotency). Honoured by 2.4+; ignored by 2.3.7. */
export const messageIdField = z
  .string()
  .optional()
  .describe(
    "Custom WhatsApp message id for idempotent retries. Requires Evolution API 2.4+ (ignored by 2.3.7).",
  );

/**
 * Event names accepted by /webhook/set and the other event transports
 * (EventController.events). MESSAGING_HISTORY_SET is 2.4+ only.
 */
export const EVOLUTION_EVENTS = [
  "APPLICATION_STARTUP",
  "QRCODE_UPDATED",
  "CONNECTION_UPDATE",
  "STATUS_INSTANCE",
  "MESSAGES_SET",
  "MESSAGING_HISTORY_SET",
  "MESSAGES_UPSERT",
  "MESSAGES_EDITED",
  "MESSAGES_UPDATE",
  "MESSAGES_DELETE",
  "SEND_MESSAGE",
  "SEND_MESSAGE_UPDATE",
  "CONTACTS_SET",
  "CONTACTS_UPSERT",
  "CONTACTS_UPDATE",
  "PRESENCE_UPDATE",
  "CHATS_SET",
  "CHATS_UPSERT",
  "CHATS_UPDATE",
  "CHATS_DELETE",
  "GROUPS_UPSERT",
  "GROUP_UPDATE",
  "GROUP_PARTICIPANTS_UPDATE",
  "LABELS_EDIT",
  "LABELS_ASSOCIATION",
  "CALL",
  "TYPEBOT_START",
  "TYPEBOT_CHANGE_STATUS",
  "REMOVE_INSTANCE",
  "LOGOUT_INSTANCE",
  "INSTANCE_CREATE",
  "INSTANCE_DELETE",
] as const;

/**
 * `events` for the set endpoints. Always sent: with `enabled:true` and no `events`
 * the server crashes with HTTP 500, so the default is `[]` (= every event).
 */
export const eventsField = z
  .array(z.enum(EVOLUTION_EVENTS))
  .default([])
  .describe(
    "Events to deliver. Empty array (default) = ALL events. MESSAGING_HISTORY_SET requires 2.4+ " +
      "(400 on 2.3.7). GROUP_UPDATE, CONTACTS_SET and APPLICATION_STARTUP are accepted but never fire.",
  );
