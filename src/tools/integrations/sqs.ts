/**
 * AWS SQS integration — /sqs/*  (nested body format)
 */

import { makeEventTransportGroup } from "./eventTransport.js";

export const sqsGroup = makeEventTransportGroup({
  base: "sqs",
  label: "AWS SQS",
  envFlag: "SQS_ENABLED",
});
