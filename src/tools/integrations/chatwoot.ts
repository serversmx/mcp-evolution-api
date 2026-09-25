/**
 * Chatwoot integration — /chatwoot/*  (flat body)
 */

import { z } from "zod";
import type { ToolDef, ToolGroup } from "../../types.js";
import { ToolInputError } from "../../client.js";
import { instanceField } from "../../schemas/common.js";
import { missingKeys, pickDefined } from "../helpers.js";

/** Fields the API requires on every write (even to disable the integration). */
const REQUIRED = [
  "enabled",
  "accountId",
  "token",
  "url",
  "signMsg",
  "reopenConversation",
  "conversationPending",
] as const;

/** Stored fields returned by /chatwoot/find that are merged back on a partial update. */
const STORED = [
  ...REQUIRED,
  "signDelimiter",
  "nameInbox",
  "importContacts",
  "mergeBrazilContacts",
  "importMessages",
  "daysLimitImportMessages",
  "organization",
  "logo",
  "ignoreJids",
] as const;

const tools: ToolDef[] = [
  {
    name: "evolution_chatwoot_set",
    description:
      "Configure the Chatwoot integration for an instance. Partial updates are safe: the current " +
      "configuration is read and merged (the API requires enabled, accountId, " +
      "token, url, signMsg, reopenConversation and conversationPending on every write). For a first-time " +
      "setup pass enabled, accountId, token and url. Requires CHATWOOT_ENABLED on the server.",
    inputSchema: z.object({
      instance: instanceField,
      enabled: z.boolean().optional().describe("Enable or disable Chatwoot."),
      accountId: z.string().optional().describe("Chatwoot account id."),
      token: z.string().optional().describe("Chatwoot user access token."),
      url: z.string().optional().describe("Chatwoot base URL."),
      signMsg: z.boolean().optional().describe("Prefix the agent name to WhatsApp messages (default false)."),
      signDelimiter: z
        .string()
        .nullable()
        .optional()
        .describe("Separator between signature and text; null clears it (ignored when signMsg is false)."),
      reopenConversation: z
        .boolean()
        .optional()
        .describe("Reuse resolved conversations instead of creating new ones (default false)."),
      conversationPending: z
        .boolean()
        .optional()
        .describe("New conversations start as pending (default false)."),
      nameInbox: z.string().nullable().optional().describe("Inbox name (null or empty resets to the instance name)."),
      number: z.string().optional().describe("Phone number used by the Chatwoot 'init' QR flow."),
      autoCreate: z
        .boolean()
        .optional()
        .describe("Create the inbox and webhook in Chatwoot automatically (not persisted)."),
      mergeBrazilContacts: z.boolean().optional().describe("Merge Brazilian 9th-digit contact variants."),
      importContacts: z.boolean().optional().describe("Import existing contacts."),
      importMessages: z.boolean().optional().describe("Import existing messages."),
      daysLimitImportMessages: z.number().int().optional().describe("Days of history to import."),
      organization: z.string().optional().describe("Bot contact organization name."),
      logo: z.string().optional().describe("Bot contact avatar URL."),
      ignoreJids: z
        .array(z.string())
        .optional()
        .describe(
          "JIDs not forwarded to Chatwoot ('@g.us' = all groups, '@s.whatsapp.net' = all 1:1). " +
            "REPLACES the stored list.",
        ),
    }),
    handler: async (client, args) => {
      const { instance, ...changes } = args;
      const inst = client.resolveInstance(instance as string | undefined);
      // Even a write with all required fields can omit nameInbox: the controller
      // resets that field to the instance name unless its stored value is merged.
      const current = await client.get(`/chatwoot/find/${inst}`);
      const body = {
        ...pickDefined(current, STORED),
        // These two nullable schema fields must retain explicit null updates.
        ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)),
      };
      // Booleans the API requires but that have an obvious "off" default.
      for (const k of ["signMsg", "reopenConversation", "conversationPending"] as const) {
        if (body[k] === undefined) body[k] = false;
      }

      const missing = missingKeys(body, REQUIRED);
      if (missing.length > 0) {
        throw new ToolInputError(
          `Chatwoot is not configured yet for this instance; pass: ${missing.join(", ")}.`,
        );
      }
      if (body.enabled === true) {
        const empty = (["accountId", "token", "url"] as const).filter((k) => body[k] === "");
        if (empty.length > 0) {
          throw new ToolInputError(`Cannot enable Chatwoot with empty: ${empty.join(", ")}.`);
        }
      }
      return client.post(`/chatwoot/set/${inst}`, { body });
    },
  },
  {
    name: "evolution_chatwoot_find",
    description:
      "Get the Chatwoot configuration for an instance (token in clear) and the webhook_url to configure in Chatwoot.",
    inputSchema: z.object({ instance: instanceField }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.get(`/chatwoot/find/${inst}`);
    },
  },
];

export const chatwootGroup: ToolGroup = {
  group: "chatwoot",
  core: false,
  label: "Chatwoot",
  tools,
};
