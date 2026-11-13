/**
 * System 8: Workspace — Trash Database Repository (Internal)
 *
 * Encapsulates low-level persistence for the `trash` table.
 */

import {
    TrashRepository,
} from "../../../../db/TrashRepository.js";

export const trashRepository = new TrashRepository();

export {
    TrashRepository,
};

export default trashRepository;
