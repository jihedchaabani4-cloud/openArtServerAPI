import { db } from "../../container.js";
import { supabase } from "../../../lib/supabase.js";
import { AppError } from "../../utils/AppError.js";
import { createLogger } from "../../infrastructure/logging/index.js";

const securityLogger = createLogger("security");

function capitalize(str) {
  if (!str) return "";
  return str.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
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

    case "workflow": {
      let wfRecord = null;
      if (db.workflows?.findById) {
        wfRecord = await db.workflows.findById(id).catch(() => null);
      }
      if (!wfRecord && db.workflows?.getWorkflow) {
        wfRecord = await db.workflows.getWorkflow(id).catch(() => null);
      }

      if (wfRecord) {
        // Direct user_id check
        if (wfRecord.user_id && wfRecord.user_id === userId) {
          resource = wfRecord;
          break;
        }

        // Project ownership check via wfRecord.project_id
        if (wfRecord.project_id && db.projects?.findByUser) {
          const matches = await db.projects.findByUser(userId, wfRecord.project_id).catch(() => []);
          if (matches?.length) {
            resource = wfRecord;
            break;
          }
        }
      }
      break;
    }

    case "media": {
      let mediaRecord = null;
      if (db.media?.findMediaByIdOrWorkflow) {
        mediaRecord = await db.media.findMediaByIdOrWorkflow(id).catch(() => null);
      }
      if (!mediaRecord && db.media?.findById) {
        mediaRecord = await db.media.findById(id).catch(() => null);
      }

      if (mediaRecord) {
        // Direct user_id check
        if (mediaRecord.user_id && mediaRecord.user_id === userId) {
          resource = mediaRecord;
          break;
        }

        // Project ownership check via mediaRecord.project_id
        if (mediaRecord.project_id && db.projects?.findByUser) {
          const matches = await db.projects.findByUser(userId, mediaRecord.project_id).catch(() => []);
          if (matches?.length) {
            resource = mediaRecord;
            break;
          }
        }

        // Fallback: check workflow's project ownership if media.workflow_id is present
        if (mediaRecord.workflow_id && db.workflows?.findById) {
          const parentWf = await db.workflows.findById(mediaRecord.workflow_id).catch(() => null);
          if (parentWf?.project_id && db.projects?.findByUser) {
            const matches = await db.projects.findByUser(userId, parentWf.project_id).catch(() => []);
            if (matches?.length) {
              resource = mediaRecord;
              break;
            }
          }
        }
      }
      break;
    }

    case "collection_item": {
      let item = null;
      if (db.collection_items?.findById) {
        item = await db.collection_items.findById(id).catch(() => null);
      } else if (db.collection_items?.findByIdAndUser) {
        item = await db.collection_items.findByIdAndUser(id, userId).catch(() => null);
      } else if (supabase) {
        const { data, error } = await supabase
          .from("collection_items")
          .select("id, user_id, project_id, collection_id, media_id, media:media_id(id, project:project!project_id(user_id))")
          .eq("id", id)
          .maybeSingle()
          .catch(() => ({ data: null, error: null }));
        if (!error && data) {
          item = data;
        }
      }

      if (item) {
        // 1. Direct user_id check
        if (item.user_id && item.user_id === userId) {
          resource = item;
          break;
        }

        // 2. Project ownership via item.project_id
        const projectId = item.project_id;
        if (projectId && db.projects?.findByUser) {
          const matches = await db.projects.findByUser(userId, projectId).catch(() => []);
          if (matches?.length) {
            resource = item;
            break;
          }
        }

        // 3. Media ownership via joined media project
        if (item.media?.project?.user_id && item.media.project.user_id === userId) {
          resource = item;
          break;
        }

        // 4. Media ownership via media_id lookup
        if (item.media_id) {
          try {
            const ownedMedia = await assertOwns("media", item.media_id, userId);
            if (ownedMedia) {
              resource = item;
              break;
            }
          } catch {}
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

/**
 * Asserts that the authenticated user owns the resource, checking across multiple possible resource types.
 * Used for polymorphic reference IDs (which may be a workflow, character, element, or media).
 * Throws AppError 404 if not found or not owned under any allowed type.
 *
 * @param {Array<string>} resourceTypes - e.g. ["workflow", "character", "element", "media"]
 * @param {string} id - Resource ID
 * @param {string} userId - Authenticated user ID
 * @returns {Promise<Object>} The resolved resource record
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

