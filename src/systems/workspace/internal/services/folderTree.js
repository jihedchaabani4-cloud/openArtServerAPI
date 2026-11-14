/**
 * Pure hierarchical tree logic for folder operations with zero external dependencies.
 */

// Indexes an array of folder objects by their unique ID into a Map.
export function indexById(folders = []) {
  const map = new Map();
  for (const folder of folders) {
    if (folder && folder.id) {
      map.set(folder.id, folder);
    }
  }
  return map;
}

// Groups an array of folder objects by parentId into a Map, using null as the key for root folders.
export function indexChildren(folders = []) {
  const map = new Map();
  for (const folder of folders) {
    if (!folder) continue;
    const parentKey = folder.parentId ?? folder.parent_id ?? null;
    const list = map.get(parentKey);
    if (list) {
      list.push(folder);
    } else {
      map.set(parentKey, [folder]);
    }
  }
  return map;
}

// Returns an array of folder IDs from the direct parent up to the root, throwing on detected cycles.
export function getAncestorIds(byId, folderId) {
  const ancestors = [];
  const visited = new Set([folderId]);
  let currentId = folderId;

  while (currentId) {
    const current = byId.get(currentId);
    const parentId = current?.parentId ?? current?.parent_id;
    if (!current || !parentId) {
      break;
    }
    if (visited.has(parentId) || parentId === currentId) {
      throw new Error("Cycle detected in stored data");
    }
    visited.add(parentId);
    ancestors.push(parentId);
    currentId = parentId;
  }
  return ancestors;
}

// Calculates the depth of a folder from root down to itself (root depth is 1, returns 0 if not found).
export function getDepth(byId, folderId) {
  if (!folderId || !byId.has(folderId)) return 0;
  const ancestors = getAncestorIds(byId, folderId);
  return ancestors.length + 1;
}

// Computes the maximum subtree height below a folder, counting the folder itself as 1.
export function getSubtreeHeight(children, folderId) {
  const directChildren = children.get(folderId);
  if (!directChildren || directChildren.length === 0) {
    return 1;
  }
  let maxHeight = 0;
  for (const child of directChildren) {
    const childHeight = getSubtreeHeight(children, child.id);
    if (childHeight > maxHeight) {
      maxHeight = childHeight;
    }
  }
  return maxHeight + 1;
}

// Collects all descendant IDs of a folder recursively into a Set, including the folder ID itself.
export function collectDescendantIds(children, folderId) {
  const result = new Set();
  function walk(id) {
    result.add(id);
    const directChildren = children.get(id);
    if (directChildren) {
      for (const child of directChildren) {
        walk(child.id);
      }
    }
  }
  if (folderId) {
    walk(folderId);
  }
  return result;
}

// Determines if moving a folder under newParentId would create a parent-child cycle.
export function wouldCreateCycle(byId, movingId, newParentId) {
  if (!newParentId) return false;
  if (movingId === newParentId) return true;
  const parentAncestors = getAncestorIds(byId, newParentId);
  return parentAncestors.includes(movingId);
}

// Checks if moving a folder subtree under newParentId would exceed the configured maximum depth limit.
export function wouldExceedDepth(byId, children, movingId, newParentId, maxDepth) {
  const parentDepth = newParentId === null || newParentId === undefined ? 0 : getDepth(byId, newParentId);
  const subtreeHeight = getSubtreeHeight(children, movingId);
  return parentDepth + subtreeHeight > maxDepth;
}

// Computes the depth that a newly created child folder would have under a given parentId.
export function depthForNewChild(byId, parentId) {
  if (parentId === null || parentId === undefined) return 1;
  return getDepth(byId, parentId) + 1;
}
