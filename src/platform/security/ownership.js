import { db } from "../../container.js";
import { AppError } from "../../utils/AppError.js";
import { createLogger } from "../../infrastructure/logging/index.js";

const securityLogger = createLogger("security");

function capitalize(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

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

    case "character": {
      let charRecord = null;
      if (db.characters?.findByCharacterId) {
        charRecord = await db.characters.findByCharacterId(id).catch(() => null);
      }
      if (!charRecord && db.characters?.findById) {
        charRecord = await db.characters.findById(id).catch(() => null);
      }

      if (charRecord) {
        // 1. Direct user_id check
        if (charRecord.user_id && charRecord.user_id === userId) {
          resource = charRecord;
          break;
        }

        // 2. Project ownership check via character.project_id
        const projectId = charRecord.project_id;
        if (projectId && db.projects?.findByUser) {
          const matches = await db.projects.findByUser(userId, projectId).catch(() => []);
          if (matches?.length) {
            resource = charRecord;
            break;
          }
        }

        // 3. Workflow ownership check via character.workflow_id
        const wfId = charRecord.workflow_id || id;
        if (db.workflows?.getWorkflow) {
          const wf = await db.workflows.getWorkflow(wfId).catch(() => null);
          if (wf?.project_id && db.projects?.findByUser) {
            const matches = await db.projects.findByUser(userId, wf.project_id).catch(() => []);
            if (matches?.length) {
              resource = charRecord;
              break;
            }
          }
        }
      } else {
        // Fallback: check if a workflow exists with this ID (legacy character container)
        if (db.workflows?.getWorkflow) {
          const wf = await db.workflows.getWorkflow(id).catch(() => null);
          if (wf?.project_id && db.projects?.findByUser) {
            const matches = await db.projects.findByUser(userId, wf.project_id).catch(() => []);
            if (matches?.length) {
              resource = wf;
              break;
            }
          }
        }
      }
      break;
    }

    case "element": {
      let elemRecord = null;
      if (db.elements?.resolveRecord) {
        elemRecord = await db.elements.resolveRecord(id).catch(() => null);
      } else if (db.elements?.findById) {
        elemRecord = await db.elements.findById(id).catch(() => null);
      }

      if (elemRecord) {
        // Elements belong to a workflow, which belongs to a project
        const wfId = elemRecord.workflow_id || id;
        if (wfId && db.workflows?.getWorkflow) {
          const wf = await db.workflows.getWorkflow(wfId).catch(() => null);
          if (wf?.project_id && db.projects?.findByUser) {
            const matches = await db.projects.findByUser(userId, wf.project_id).catch(() => []);
            if (matches?.length) {
              resource = elemRecord;
              break;
            }
          }
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
    throw new AppError(`${capitalize(resourceType)} not found`, 404);
  }

  return resource;
}
