/**
 * System 8: Workspace — Project Database Repository (Internal)
 *
 * Encapsulates low-level persistence for the `project` table.
 */

import {
    ProjectRepository,
} from "../../../../db/ProjectRepository.js";

export const projectRepository = new ProjectRepository();

export {
    ProjectRepository,
};

export default projectRepository;
