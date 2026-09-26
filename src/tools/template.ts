/**
 * Meta message templates — /template/*  (WHATSAPP-BUSINESS / Cloud API instances only)
 */

import { z } from "zod";
import type { ToolDef, ToolGroup } from "../types.js";
import { instanceField } from "../schemas/common.js";
import { postBody } from "./helpers.js";

const cloudOnly = " WHATSAPP-BUSINESS (Cloud API) instances only (uses the instance token and businessId).";
const categoryField = z.enum(["AUTHENTICATION", "MARKETING", "UTILITY"]);
const componentsField = z
  .array(z.record(z.any()))
  .describe("Meta template components array (HEADER/BODY/FOOTER/BUTTONS), passed verbatim to the Graph API.");

const tools: ToolDef[] = [
  {
    name: "evolution_template_create",
    description: `Create a Meta message template for approval.${cloudOnly}`,
    inputSchema: z.object({
      instance: instanceField,
      name: z.string().describe("Template name (lowercase, underscores)."),
      category: categoryField.describe("Meta category."),
      language: z.string().describe("Language code, e.g. es_MX, en_US."),
      components: componentsField.min(1),
      allowCategoryChange: z.boolean().optional().describe("Let Meta recategorise the template."),
      webhookUrl: z.string().optional().describe("Status callback URL stored with the template."),
    }),
    handler: postBody("/template/create"),
  },
  {
    name: "evolution_template_edit",
    description: `Edit an existing Meta message template.${cloudOnly}`,
    inputSchema: z.object({
      instance: instanceField,
      templateId: z.string().describe("Meta template id."),
      category: categoryField.optional().describe("New category."),
      allowCategoryChange: z.boolean().optional().describe("Let Meta recategorise the template."),
      ttl: z.number().int().positive().optional().describe("Message time-to-live in seconds."),
      components: componentsField.optional(),
    }),
    handler: postBody("/template/edit"),
  },
  {
    name: "evolution_template_delete",
    description: `Delete a Meta message template (all languages, or one with hsmId).${cloudOnly}`,
    inputSchema: z.object({
      instance: instanceField,
      name: z.string().describe("Template name."),
      hsmId: z.string().optional().describe("Template id: delete only that language version."),
    }),
    handler: async (client, args) => {
      const { instance, ...body } = args;
      const inst = client.resolveInstance(instance as string | undefined);
      return client.delete(`/template/delete/${inst}`, { body });
    },
  },
  {
    name: "evolution_template_find",
    description: `List the Meta message templates of the WhatsApp Business account.${cloudOnly}`,
    inputSchema: z.object({ instance: instanceField }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.get(`/template/find/${inst}`);
    },
  },
];

export const templateGroup: ToolGroup = {
  group: "template",
  core: false,
  label: "Meta templates (Cloud API)",
  tools,
};
