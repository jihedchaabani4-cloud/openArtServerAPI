/**
 * @owns System 5: Identity & Auth
 * OwnershipService
 * Asserts resource ownership to prevent horizontal privilege escalation and resource enumeration attacks.
 * Conforms to Rule 2, Rule 7, Rule 8, and Rule 12.
 */
import { AppError, createLogger } from "#shared";
import { findCollectionItemById } from "../db/ownershipDb.js";

const securityLogger = createLogger("security");

let _db = null;

export function setDb(dbInstance) {
  _db = dbInstance;
}

async function getDb() {
  return _db || {};
}

function capitalize(str) {
  if (!str) return "";
  return str.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * Asserts that the authenticated user owns the specified resource.
 * Throws AppError with HTTP 404 (NOT 403) on mismatch or missing resource
 * to prevent resource enumeration attacks.
 *
 * @param {"project" | "character" | "element" | "media" | "workflow" | "collection_item" | "folder"} resourceType
 * @param {string} id - Resource ID
 * @param {string} userId - Authenticated user ID
 * @returns {Promise<Object>} The resolved resource record
 */
export async function assertOwns(resourceType, id, userId) {
  const db = await getDb();
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
        // Direct user_id check on element if present
        if (elemRecord.user_id && elemRecord.user_id === userId) {
          resource = elemRecord;
          break;
        }

        // Elements belong to a workflow, which belongs to a project.
        const wfId = elemRecord.workflow_id || id;
        let wf = null;
        if (wfId && db.workflows?.getWorkflow) {
          wf = await db.workflows.getWorkflow(wfId).catch(() => null);
        }
        if (!wf && wfId && db.workflows?.findById) {
          wf = await db.workflows.findById(wfId).catch(() => null);
        }

        if (wf) {
          // Direct user_id match on the workflow
          if (wf.user_id && wf.user_id === userId) {
            resource = elemRecord;
            break;
          }
          // Project membership check
          if (wf.project_id && db.projects?.findByUser) {
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
      if (!wfRecord && db.workflowMedia?.findByMedia && db.workflows?.findById) {
        const links = await db.workflowMedia.findByMedia(id).catch(() => []);
        const linkedWfId = links?.[0]?.workflow_id;
        if (linkedWfId) {
          wfRecord = await db.workflows.findById(linkedWfId).catch(() => null);
        }
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

        // Fallback: check workflow's project ownership via workflow_media relation
        if (db.workflowMedia?.findByMedia && db.workflows?.findById) {
          const links = await db.workflowMedia.findByMedia(mediaRecord.id || id).catch(() => []);
          const linkedWfId = links?.[0]?.workflow_id;
          if (linkedWfId) {
            const parentWf = await db.workflows.findById(linkedWfId).catch(() => null);
            if (parentWf?.project_id && db.projects?.findByUser) {
              const matches = await db.projects.findByUser(userId, parentWf.project_id).catch(() => []);
              if (matches?.length) {
                resource = mediaRecord;
                break;
              }
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
      } else {
        item = await findCollectionItemById(id);
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

    case "folder": {
      if (db.folders?.findOwned) {
        const folder = await db.folders.findOwned(id, userId).catch(() => null);
        if (folder) {
          if (folder.project_id && db.projects?.findByUser) {
            const matches = await db.projects.findByUser(userId, folder.project_id).catch(() => []);
            if (matches?.length) {
              resource = folder;
              break;
            }
          } else {
            resource = folder;
            break;
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
  setDb,
};

export default OwnershipService;
