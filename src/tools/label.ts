/**
 * Label Controller — /label/*
 */

import { z } from "zod";
import type { ToolDef, ToolGroup } from "../types.js";
import { instanceField, numberField } from "../schemas/common.js";

const tools: ToolDef[] = [
  {
    name: "evolution_label_find",
    description: "List all labels in an instance (WhatsApp Business accounts only).",
    inputSchema: z.object({ instance: instanceField }),
    handler: async (client, args) => {
      const inst = client.resolveInstance(args.instance as string | undefined);
      return client.get(`/label/findLabels/${inst}`);
    },
  },
  {
    name: "evolution_label_handle",
    description: "Add or remove a label on a chat.",
    inputSchema: z.object({
      instance: instanceField,
      number: numberField.describe("Chat number or JID to label."),
      labelId: z.string().describe("Label id."),
      action: z.enum(["add", "remove"]).describe("Whether to add or remove the label."),
    }),
    handler: async (client, args) => {
      const { instance, ...body } = args;
      const inst = client.resolveInstance(instance as string | undefined);
      return client.post(`/label/handleLabel/${inst}`, { body });
    },
  },
];

export const labelGroup: ToolGroup = {
  group: "label",
  core: true,
  label: "Labels",
  tools,
};
