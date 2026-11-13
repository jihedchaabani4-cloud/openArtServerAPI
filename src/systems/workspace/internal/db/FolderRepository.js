/**
 * System 8: Workspace — Folder Database Repository (Internal)
 *
 * Encapsulates low-level persistence for the `folders` table.
 */

import {
    FolderRepository,
} from "../../../../db/FolderRepository.js";

export const folderRepository = new FolderRepository();

export {
    FolderRepository,
};

export default folderRepository;
