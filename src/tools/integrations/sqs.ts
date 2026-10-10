/**
 * AWS SQS integration — /sqs/*  (nested body format)
 */

import { makeEventTransportGroup } from "./eventTransport.js";

export const sqsGroup = makeEventTransportGroup({
  base: "sqs",
  label: "AWS SQS",
  envFlag: "SQS_ENABLED",
  extraNote: "It is also a no-op when SQS_GLOBAL_ENABLED=true (global mode).",
});
