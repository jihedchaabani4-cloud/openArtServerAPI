import { ValidationError } from "../../errors/index.js";

export function validateString(key, val, rule = {}) {
  if (typeof val !== "string") {
    throw new ValidationError(`Field "${key}" must be a string`, { field: key });
  }
  if (rule.minLength !== undefined && val.length < rule.minLength) {
    throw new ValidationError(`Field "${key}" must have length at least ${rule.minLength}`, { field: key });
  }
  if (rule.maxLength !== undefined && val.length > rule.maxLength) {
    throw new ValidationError(`Field "${key}" exceeds maximum length of ${rule.maxLength}`, { field: key });
  }
  return val;
}

export function validateEnum(key, val, rule = {}) {
  const allowed = Array.isArray(rule.values) ? rule.values : [];
  const strVal = typeof val === "number" ? String(val) : val;
  if (!allowed.includes(val) && !allowed.includes(strVal)) {
    throw new ValidationError(`Field "${key}" has invalid value "${val}"`, { field: key });
  }
  return allowed.includes(val) ? val : strVal;
}

export function validateInteger(key, val, rule = {}) {
  if (typeof val !== "number" || !Number.isInteger(val)) {
    throw new ValidationError(`Field "${key}" must be an integer`, { field: key });
  }
  if (rule.min !== undefined && val < rule.min) {
    throw new ValidationError(`Field "${key}" must be at least ${rule.min}`, { field: key });
  }
  if (rule.max !== undefined && val > rule.max) {
    throw new ValidationError(`Field "${key}" must be at most ${rule.max}`, { field: key });
  }
  return val;
}

export function validateFloat(key, val, rule = {}) {
  if (typeof val !== "number" || !Number.isFinite(val)) {
    throw new ValidationError(`Field "${key}" must be a float`, { field: key });
  }
  if (rule.min !== undefined && val < rule.min) {
    throw new ValidationError(`Field "${key}" must be at least ${rule.min}`, { field: key });
  }
  if (rule.max !== undefined && val > rule.max) {
    throw new ValidationError(`Field "${key}" must be at most ${rule.max}`, { field: key });
  }
  return val;
}

export function validateBoolean(key, val) {
  if (typeof val !== "boolean") {
    throw new ValidationError(`Field "${key}" must be a boolean`, { field: key });
  }
  return val;
}
