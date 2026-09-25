/**
 * Kafka integration — /kafka/*  (nested body format)
 */

import { makeEventTransportGroup } from "./eventTransport.js";

export const kafkaGroup = makeEventTransportGroup({
  base: "kafka",
  label: "Kafka",
  envFlag: "KAFKA_ENABLED",
});
