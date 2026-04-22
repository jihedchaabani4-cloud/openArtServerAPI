import { jobQueue } from "./queue.js";

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertSerializableValue(value, path = "payload") {
  if (value === null || value === undefined) return;

  const valueType = typeof value;
  if (valueType === "string" || valueType === "number" || valueType === "boolean") {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSerializableValue(item, `${path}[${index}]`));
    return;
  }

  if (valueType === "object") {
    if (!isPlainObject(value)) {
      throw new Error(`Task must contain only plain JSON objects. Invalid value at "${path}".`);
    }

    for (const [key, nestedValue] of Object.entries(value)) {
      assertSerializableValue(nestedValue, `${path}.${key}`);
    }
    return;
  }

  throw new Error(`Task is not JSON serializable. Invalid value at "${path}" (${valueType}).`);
}

export function ensureSerializableTask(payload) {
  assertSerializableValue(payload, "payload");
  return JSON.parse(JSON.stringify(payload));
}

export async function enqueueTreatmentJob(type, payload, options = {}) {
  const safePayload = ensureSerializableTask(payload);
  const job = await jobQueue.add(type, { type, payload: safePayload }, options);
  return job;
}
