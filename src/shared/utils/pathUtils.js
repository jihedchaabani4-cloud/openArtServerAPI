const FORBIDDEN_PATH_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Safely resolves a value from an object or array by key or dot-separated path
 * (e.g. "parameters.duration", "items.0.title", "items[0].title", "user_profile").
 * Guards against prototype-pollution keys and supports camelCase <-> snake_case aliases.
 *
 * @param {Object|Array} obj
 * @param {string} path
 * @returns {*}
 */
export function getValueByPath(obj, path) {
  if (!obj || typeof obj !== "object" || !path || typeof path !== "string") {
    return undefined;
  }
  const trimmedPath = path.trim();
  if (!trimmedPath || FORBIDDEN_PATH_KEYS.has(trimmedPath)) {
    return undefined;
  }

  if (!Array.isArray(obj)) {
    if (Object.prototype.hasOwnProperty.call(obj, trimmedPath) && obj[trimmedPath] !== undefined) {
      return obj[trimmedPath];
    }

    const camelKey = trimmedPath.replace(/_([a-z0-9])/g, (_, g) => g.toUpperCase());
    if (
      camelKey !== trimmedPath &&
      !FORBIDDEN_PATH_KEYS.has(camelKey) &&
      Object.prototype.hasOwnProperty.call(obj, camelKey) &&
      obj[camelKey] !== undefined
    ) {
      return obj[camelKey];
    }
    const snakeKey = trimmedPath.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`);
    if (
      snakeKey !== trimmedPath &&
      !FORBIDDEN_PATH_KEYS.has(snakeKey) &&
      Object.prototype.hasOwnProperty.call(obj, snakeKey) &&
      obj[snakeKey] !== undefined
    ) {
      return obj[snakeKey];
    }
  }

  const normalizedPath = trimmedPath.replace(/\[(\d+)\]/g, ".$1").replace(/^\./, "");
  const parts = normalizedPath.split(".");
  let current = obj;
  for (const part of parts) {
    if (!part || FORBIDDEN_PATH_KEYS.has(part)) {
      return undefined;
    }
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part)) {
        return undefined;
      }
      const idx = Number(part);
      if (idx < 0 || idx >= current.length) {
        return undefined;
      }
      current = current[idx];
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(current, part) && current[part] !== undefined) {
      current = current[part];
    } else {
      const partCamel = part.replace(/_([a-z0-9])/g, (_, g) => g.toUpperCase());
      const partSnake = part.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`);
      if (
        !FORBIDDEN_PATH_KEYS.has(partCamel) &&
        Object.prototype.hasOwnProperty.call(current, partCamel) &&
        current[partCamel] !== undefined
      ) {
        current = current[partCamel];
      } else if (
        !FORBIDDEN_PATH_KEYS.has(partSnake) &&
        Object.prototype.hasOwnProperty.call(current, partSnake) &&
        current[partSnake] !== undefined
      ) {
        current = current[partSnake];
      } else {
        return undefined;
      }
    }
  }
  return current;
}

export default { getValueByPath };
