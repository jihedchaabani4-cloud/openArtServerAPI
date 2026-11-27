/**
 * @owns System 5: Identity & Auth
 * OwnershipService
 * Asserts resource ownership to prevent horizontal privilege escalation and resource enumeration attacks.
 * Uses inverted per-resource-type ownership resolvers configured at the composition root (src/container.js)
 * so System 5 (Identity) has zero knowledge of foreign repositories or table schemas.
 * Conforms to Rule 2, Rule 7, Rule 8, and Rule 12.
 */
import { AppError, createLogger, envConfig } from "#shared";
import { IdentityForbiddenError } from "../errors.js";

const securityLogger = createLogger("security");

const _resolvers = new Map();
let _configured = false;

/**
 * Configures per-resource-type ownership resolvers at bootstrap (src/container.js).
 * Reassignment is blocked outside NODE_ENV === "test".
 *
 * @param {Record<string, (id: string, userId: string, helpers: { assertOwns: Function }) => Promise<Object|null>> | null} resolvers
 */
export function configureOwnershipResolvers(resolvers) {
  if (!envConfig.isTest && _configured) {
    throw new IdentityForbiddenError(
      "OwnershipService resolvers are already initialized and cannot be reassigned outside tests."
    );
  }
  _resolvers.clear();
  if (resolvers && typeof resolvers === "object") {
    for (const [resourceType, resolverFn] of Object.entries(resolvers)) {
      if (typeof resolverFn === "function") {
        _resolvers.set(resourceType, resolverFn);
      }
    }
  }
  _configured = _resolvers.size > 0;
}

function capitalize(str) {
  if (!str) return "";
  return str
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Asserts that the authenticated user owns the specified resource.
 * Throws AppError with HTTP 404 (NOT 403) on mismatch or missing resource
 * to prevent resource enumeration attacks.
 *
 * @param {string} resourceType - Registered resource type (e.g. "project", "character", "element", "media", "workflow", "folder")
 * @param {string} id - Resource ID
 * @param {string} userId - Authenticated user ID
 * @returns {Promise<Object>} The resolved resource record
 */
export async function assertOwns(resourceType, id, userId) {
  if (!id) {
    throw new AppError(`${resourceType} ID is required`, 400);
  }
  if (!userId) {
    throw new AppError("Authentication required", 401);
  }

  const resolver = _resolvers.get(resourceType);
  if (!resolver) {
    throw new AppError(`Unsupported resource type for ownership check: ${resourceType}`, 500);
  }

  const resource = await resolver(id, userId, { assertOwns });

  if (!resource) {
    securityLogger.warn(
      { event: "ownership.denied", resourceType, resourceId: id, userId },
      `Ownership check failed: resource "${resourceType}" with ID "${id}" not found or not owned by user "${userId}"`
    );
    throw new AppError(`${capitalize(resourceType)} not found`, 404);
  }

  return resource;
}

/**
 * Asserts that the authenticated user owns the resource, checking across multiple possible resource types.
 *
 * @param {Array<string>} resourceTypes
 * @param {string} id - Resource ID
 * @param {string} userId - Authenticated user ID
 * @returns {Promise<Object>}
 */
export async function assertOwnsAny(resourceTypes, id, userId) {
  for (const type of resourceTypes) {
    try {
      const res = await assertOwns(type, id, userId);
      if (res) return res;
    } catch {
      // Try next resource type
    }
  }
  securityLogger.warn(
    { event: "ownership.denied", resourceTypes, resourceId: id, userId },
    `Ownership check failed for any of [${resourceTypes.join(", ")}] with ID "${id}" for user "${userId}"`
  );
  throw new AppError("Reference not found", 404);
}

/**
 * Normalizes any media or reference parameter value into a flat array of string IDs/URLs.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function toMediaIdList(value) {
  if (value === null || value === undefined) return [];

  const extractSingle = (item) => {
    if (typeof item === "string") {
      return item.trim();
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const candidate =
        item.workflow_id ||
        item.workflowId ||
        item.id ||
        item.media_id ||
        item.mediaId ||
        item.url ||
        "";
      return typeof candidate === "string" ? candidate.trim() : "";
    }
    return "";
  };

  if (Array.isArray(value)) {
    const out = [];
    for (const entry of value) {
      const id = extractSingle(entry);
      if (id) out.push(id);
    }
    return out;
  }

  const single = extractSingle(value);
  return single ? [single] : [];
}

export const OwnershipService = {
  assertOwns,
  assertOwnsAny,
  toMediaIdList,
  configureOwnershipResolvers,
};

export default OwnershipService;
