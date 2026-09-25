/**
 * Send Message Controller — /message/*
 */

import { z } from "zod";
import type { ToolDef, ToolGroup } from "../types.js";
import { ToolInputError } from "../client.js";
import {
  instanceField,
  numberField,
  messageKey,
  sendOptionsShape,
  delayField,
  quotedField,
  messageIdField,
} from "../schemas/common.js";
import { postBody } from "./helpers.js";

const mediaNote =
  "URL or RAW base64 (no 'data:...;base64,' prefix). Local file upload (multipart) is not supported by this tool.";

const tools: ToolDef[] = [
  {
    name: "evolution_message_send_text",
    description: "Send a text message to a WhatsApp number or group (WhatsApp markdown supported).",
    inputSchema: z.object({
      instance: instanceField,
      number: numberField,
      text: z.string().describe("Message text."),
      linkPreview: z
        .boolean()
        .optional()
        .describe(
          "Link preview. On 2.4+ the server fetches the first URL unless this is false; send false to skip it.",
        ),
      messageId: messageIdField,
      ...sendOptionsShape,
    }),
    handler: postBody("/message/sendText"),
  },
  {
    name: "evolution_message_send_media",
    description:
      "Send an image, video, document or audio file by URL or raw base64. Supports JSON or multipart " +
      "uploads from raw base64. For voice notes (PTT) use evolution_message_send_audio. Images are re-encoded to JPEG.",
    inputSchema: z.object({
      instance: instanceField,
      number: numberField,
      mediatype: z
        .enum(["image", "video", "document", "audio"])
        .describe("Type of media. 'audio' sends a regular audio file, not a voice note."),
      media: z.string().min(1).describe("Media URL or RAW base64 (no data: prefix). Multipart requires raw base64."),
      transport: z
        .enum(["json", "multipart"])
        .default("json")
        .describe("Request format. Multipart uploads decoded base64 under the file field; delay, quoted and mentions are unsupported in this format."),
      mimetype: z
        .string()
        .optional()
        .describe("MIME type, e.g. image/png. When fileName is set the server derives it from the extension."),
      caption: z.string().optional().describe("Caption text (image/video/document)."),
      fileName: z
        .string()
        .optional()
        .describe("File name WITH extension. Required for base64 documents."),
      gifPlayback: z.boolean().optional().describe("Video only: play as GIF. Requires Evolution API 2.4+."),
      gifAttribution: z
        .union([z.literal(0), z.literal(1), z.literal(2)])
        .optional()
        .describe("Video only: GIF attribution (0 none, 1 GIPHY, 2 TENOR). Requires Evolution API 2.4+."),
      messageId: messageIdField,
      ...sendOptionsShape,
    }),
    handler: async (client, args) => {
      const { instance, transport, media, ...fields } = args;
      const inst = client.resolveInstance(instance as string | undefined);
      if (transport !== "multipart") {
        return client.post(`/message/sendMedia/${inst}`, { body: { ...fields, media } });
      }
      // Multer leaves form fields as strings. Evolution only accepts string
      // forms for the GIF options; sending typed send options would fail schema validation.
      const unsupported = ["delay", "quoted", "mentionsEveryOne", "mentioned"].filter(
        (key) => fields[key] !== undefined,
      );
      if (unsupported.length > 0) {
        throw new ToolInputError(`Multipart media does not support ${unsupported.join(", ")}. Use transport=json.`);
      }
      if (
        typeof media !== "string" ||
        media.length === 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(media)
      ) {
        throw new ToolInputError("Multipart media must be raw base64 (no URL or data: prefix).");
      }
      if (fields.mediatype === "document" && !fields.fileName) {
        throw new ToolInputError("Multipart documents require fileName with an extension.");
      }
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) form.append(key, String(value));
      }
      form.append(
        "file",
        new Blob([Buffer.from(media, "base64")], { type: (fields.mimetype as string | undefined) ?? "application/octet-stream" }),
        (fields.fileName as string | undefined) ?? "upload",
      );
      return client.post(`/message/sendMedia/${inst}`, { body: form });
    },
  },
  {
    name: "evolution_message_send_ptv",
    description: "Send a PTV (round video note) message.",
    inputSchema: z.object({
      instance: instanceField,
      number: numberField,
      video: z.string().describe(`MP4 video ${mediaNote}`),
      messageId: messageIdField,
      ...sendOptionsShape,
    }),
    handler: postBody("/message/sendPtv"),
  },
  {
    name: "evolution_message_send_audio",
    description:
      "Send a WhatsApp voice note (PTT) by URL or raw base64. Mentions are never applied to audio.",
    inputSchema: z.object({
      instance: instanceField,
      number: numberField,
      audio: z.string().describe(`Audio ${mediaNote}`),
      encoding: z
        .boolean()
        .optional()
        .describe("Default true: convert to OGG/Opus with ffmpeg. false sends as-is (must already be ogg/opus)."),
      delay: delayField,
      quoted: quotedField.describe(
        "Message to reply to. Ignored by Evolution API 2.3.7; honoured since 2.4.",
      ),
    }),
    handler: postBody("/message/sendWhatsAppAudio"),
  },
  {
    name: "evolution_message_send_sticker",
    description: "Send a sticker by URL or raw base64 (converted to WebP unless notConvertSticker).",
    inputSchema: z.object({
      instance: instanceField,
      number: numberField,
      sticker: z.string().describe(`Sticker image ${mediaNote}`),
      notConvertSticker: z
        .boolean()
        .optional()
        .describe("true = sticker is already WebP base64 (URLs not allowed then)."),
      messageId: messageIdField,
      ...sendOptionsShape,
    }),
    handler: postBody("/message/sendSticker"),
  },
  {
    name: "evolution_message_send_location",
    description: "Send a location (latitude/longitude).",
    inputSchema: z.object({
      instance: instanceField,
      number: numberField,
      name: z.string().describe("Location name."),
      address: z.string().describe("Location address."),
      latitude: z.number().describe("Latitude."),
      longitude: z.number().describe("Longitude."),
      ...sendOptionsShape,
    }),
    handler: postBody("/message/sendLocation"),
  },
  {
    name: "evolution_message_send_contact",
    description:
      "Send one or more contact cards (vCards). Delay, quote and mentions are not applied to contacts.",
    inputSchema: z.object({
      instance: instanceField,
      number: numberField,
      contact: z
        .array(
          z.object({
            fullName: z.string().min(1).describe("Contact display name."),
            phoneNumber: z.string().min(10).describe("Phone number as displayed (min 10 chars)."),
            wuid: z
              .string()
              .regex(/^\d{10,}$/, "wuid must be digits only (no JID suffix)")
              .optional()
              .describe(
                "WhatsApp id, DIGITS ONLY (e.g. 5215550123456), used as waid= in the vCard. " +
                  "Never pass a JID: '@s.whatsapp.net' breaks the vCard. Recommended.",
              ),
            organization: z.string().optional().describe("Organization."),
            email: z.string().optional().describe("Email."),
            url: z.string().optional().describe("URL."),
          }),
        )
        .min(1)
        .describe("Contacts to send."),
    }),
    handler: postBody("/message/sendContact"),
  },
  {
    name: "evolution_message_send_reaction",
    description: "React to a message with an emoji (the chat is taken from key.remoteJid).",
    inputSchema: z.object({
      instance: instanceField,
      key: messageKey,
      reaction: z.string().describe("Exactly one emoji, e.g. '👍'. Empty string removes the reaction."),
    }),
    handler: postBody("/message/sendReaction"),
  },
  {
    name: "evolution_message_send_poll",
    description:
      "Send a poll. Votes arrive as MESSAGES_UPDATE events, or read them with evolution_chat_get_poll_vote (2.4+).",
    inputSchema: z.object({
      instance: instanceField,
      number: numberField,
      name: z.string().describe("Poll question/title."),
      selectableCount: z
        .number()
        .int()
        .min(0)
        .max(10)
        .describe("How many options a user can pick: 0 = any number, 1 = single choice."),
      values: z.array(z.string()).min(2).max(10).describe("Poll options (2-10, unique)."),
      messageId: messageIdField,
      ...sendOptionsShape,
    }),
    handler: postBody("/message/sendPoll"),
  },
  {
    name: "evolution_message_send_list",
    description: "Send an interactive list message (sections with selectable rows).",
    inputSchema: z.object({
      instance: instanceField,
      number: numberField,
      title: z.string().describe("List title."),
      description: z.string().optional().describe("Body text."),
      buttonText: z.string().describe("Text on the button that opens the list."),
      footerText: z.string().describe("Footer text (required by the API)."),
      sections: z
        .array(
          z.object({
            title: z.string().min(1).describe("Section title."),
            rows: z
              .array(
                z.object({
                  title: z.string().min(1).describe("Row title."),
                  description: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("Row description. Omit it instead of sending an empty string."),
                  rowId: z.string().min(1).describe("Row id returned in the reply."),
                }),
              )
              .min(1)
              .describe("Rows of the section."),
          }),
        )
        .min(1)
        .describe("List sections and rows."),
      ...sendOptionsShape,
    }),
    handler: postBody("/message/sendList"),
  },
  {
    name: "evolution_message_send_buttons",
    description:
      "Send a message with interactive buttons. Rules: reply buttons max 3 and not mixed with others; " +
      "pix exactly 1 alone; url/call/copy max 2 on 2.4+.",
    inputSchema: z.object({
      instance: instanceField,
      number: numberField,
      title: z.string().describe("Message title (rendered bold)."),
      description: z.string().optional().describe("Message body."),
      footer: z.string().optional().describe("Footer text."),
      thumbnailUrl: z.string().optional().describe("Header image URL."),
      buttons: z
        .array(
          z.object({
            type: z.enum(["reply", "copy", "url", "call", "pix"]).describe("Button type."),
            displayText: z.string().optional().describe("Label (reply/copy/url/call)."),
            id: z.string().optional().describe("reply: id returned when tapped."),
            url: z.string().optional().describe("url: target URL."),
            copyCode: z.string().optional().describe("copy: code copied to the clipboard."),
            phoneNumber: z.string().optional().describe("call: phone number."),
            currency: z.string().optional().describe("pix: currency, e.g. BRL."),
            name: z.string().optional().describe("pix: merchant name."),
            keyType: z
              .enum(["phone", "email", "cpf", "cnpj", "random"])
              .optional()
              .describe("pix: key type."),
            key: z.string().optional().describe("pix: PIX key."),
          }),
        )
        .min(1)
        .describe("Buttons."),
      ...sendOptionsShape,
    }),
    handler: postBody("/message/sendButtons"),
  },
  {
    name: "evolution_message_send_status",
    description:
      "Post a WhatsApp status (story). type=text requires backgroundColor and font (1-5); image/video " +
      "content must be a URL (base64 does not work). Best-effort on the server.",
    inputSchema: z.object({
      instance: instanceField,
      type: z.enum(["text", "image", "video", "audio"]).describe("Status type."),
      content: z
        .string()
        .describe("text: the text. image/video: a URL. audio: URL or raw base64."),
      caption: z.string().optional().describe("Caption (image/video)."),
      backgroundColor: z
        .string()
        .optional()
        .describe("Background color, e.g. #008000. Required for type=text."),
      font: z.number().int().min(1).max(5).optional().describe("Font index 1-5. Required for type=text."),
      allContacts: z.boolean().optional().describe("Send to all stored contacts."),
      statusJidList: z
        .array(z.string())
        .optional()
        .describe("Recipient full JIDs (…@s.whatsapp.net). Required unless allContacts is true."),
    }),
    handler: postBody("/message/sendStatus"),
  },
  {
    name: "evolution_message_send_template",
    description:
      "Send an approved Meta template. WHATSAPP-BUSINESS (Cloud API) instances only; Baileys instances fail.",
    inputSchema: z.object({
      instance: instanceField,
      number: numberField,
      name: z.string().describe("Approved template name."),
      language: z.string().describe("Template language code, e.g. es_MX, en_US, pt_BR."),
      components: z
        .array(z.record(z.any()))
        .optional()
        .describe("Meta components array (header/body/button parameters), passed verbatim to the Graph API."),
      webhookUrl: z.string().optional().describe("EVOLUTION channel only: per-message callback URL."),
    }),
    handler: postBody("/message/sendTemplate"),
  },
  {
    name: "evolution_message_send_carousel",
    description:
      "Send a carousel of cards with buttons. Requires Evolution API 2.4+ (404 on 2.3.7). Baileys only.",
    inputSchema: z.object({
      instance: instanceField,
      number: numberField,
      body: z.string().min(1).describe("Carousel body text."),
      cards: z
        .array(
          z.object({
            title: z.string().optional().describe("Card title."),
            body: z.string().min(1).describe("Card body."),
            footer: z.string().optional().describe("Card footer."),
            imageUrl: z.string().optional().describe("Card header image URL."),
            buttons: z
              .array(
                z.object({
                  type: z.enum(["reply", "copy", "url", "call"]).describe("Button type (no pix)."),
                  displayText: z.string().optional().describe("Label."),
                  id: z.string().optional().describe("reply: id returned when tapped."),
                  url: z.string().optional().describe("url: target URL."),
                  copyCode: z.string().optional().describe("copy: code copied to the clipboard."),
                  phoneNumber: z.string().optional().describe("call: phone number."),
                }),
              )
              .min(1)
              .max(3)
              .describe("1-3 buttons per card."),
          }),
        )
        .min(1)
        .max(10)
        .describe("1-10 cards."),
      ...sendOptionsShape,
    }),
    handler: postBody("/message/sendCarousel"),
  },
];

export const messageGroup: ToolGroup = {
  group: "message",
  core: true,
  label: "Send messages",
  tools,
};
