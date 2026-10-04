import { db } from "../../container.js";
import { AppError } from "../../utils/AppError.js";
import { createLogger } from "../../infrastructure/logging/index.js";

const securityLogger = createLogger("security");

/**
 * Asserts that the authenticated user owns the specified resource.
 * Throws AppError with HTTP 404 (NOT 403) on mismatch or missing resource
 * to prevent resource enumeration attacks.
 *
 * @param {"project" | "character" | "element" | "media" | "workflow"} resourceType
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

  let resource = null;

  switch (resourceType) {
    case "project": {
      if (db.projects?.findByUser) {
        const matches = await db.projects.findByUser(userId, id);
        resource = matches?.[0] || null;
      } else if (db.projects?.findById) {
        const record = await db.projects.findById(id);
        if (record && record.user_id === userId) {
          resource = record;
        }
      }
      break;
    }

    default:
      throw new AppError(`Unsupported resource type for ownership check: ${resourceType}`, 500);
  }

  if (!resource) {
    securityLogger.warn(
      { event: "ownership.denied", resourceType, resourceId: id, userId },
      `Ownership check failed: resource "${resourceType}" with ID "${id}" not found or not owned by user "${userId}"`
    );
    throw new AppError("Project not found", 404);
  }

  return resource;
}
