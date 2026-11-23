/**
 * Canonical media status constants and pure status predicates.
 *
 * Kept dependency-free so repositories, services, and public tools can share
 * a single source of truth without circular dependencies (Rule R14).
 */

/** Canonical media statuses written to the V1 `media` table. */
export const MEDIA_WORKFLOW_STATUS = {
  PROCESSING: "processing",
  SUCCESS: "success",
  FAILED: "failed",
};

/** Canonical in-flight media statuses that must not be deleted or trashed. */
export const MEDIA_IN_FLIGHT_STATUSES = Object.freeze([
  "processing",
  "pending",
  "queued",
  "uploading",
  "in_progress",
  "starting",
]);

const MEDIA_IN_FLIGHT_STATUS_SET = new Set(MEDIA_IN_FLIGHT_STATUSES);

function normalizeMediaStatusValue(mediaOrStatus) {
  if (mediaOrStatus === null || mediaOrStatus === undefined) return "";
  const raw = typeof mediaOrStatus === "object" ? mediaOrStatus.status : mediaOrStatus;
  if (typeof raw !== "string") return "";
  return raw.trim().toLowerCase();
}

/**
 * Returns true when `mediaOrStatus` is in an active/in-flight state.
 * Treats null, undefined, or empty status as NOT in-flight so minimal unit-test mocks do not break.
 *
 * @param {string|{ status?: string|null }|null|undefined} mediaOrStatus
 * @returns {boolean}
 */
export function isMediaInFlight(mediaOrStatus) {
  const status = normalizeMediaStatusValue(mediaOrStatus);
  return status.length > 0 && MEDIA_IN_FLIGHT_STATUS_SET.has(status);
}

/**
 * Returns true when `mediaOrStatus` has normalized status === "failed".
 *
 * @param {string|{ status?: string|null }|null|undefined} mediaOrStatus
 * @returns {boolean}
 */
export function isMediaFailed(mediaOrStatus) {
  return normalizeMediaStatusValue(mediaOrStatus) === MEDIA_WORKFLOW_STATUS.FAILED;
}

/**
 * Returns true if any entry in `mediaList` is in-flight.
 *
 * @param {Array<string|{ status?: string|null }>} mediaList
 * @returns {boolean}
 */
export function hasInFlightMedia(mediaList) {
  return Array.isArray(mediaList) && mediaList.some(isMediaInFlight);
}

/**
 * Returns true if `mediaList` is non-empty and every entry has status === "failed".
 *
 * @param {Array<string|{ status?: string|null }>} mediaList
 * @returns {boolean}
 */
export function areAllWorkflowMediaFailed(mediaList) {
  return Array.isArray(mediaList) && mediaList.length > 0 && mediaList.every(isMediaFailed);
}
