import { DnaRepository } from "./DnaRepository.js";

/**
 * CharacterRepository — Dedicated Repository for Characters.
 * Interacts with character records (traits, persona, 3-view turnaround specs).
 */
export class CharacterRepository extends DnaRepository {
  async getCharacterByWorkflowId(workflowId) {
    return this.getByWorkflowId(workflowId);
  }

  async createCharacter({ generation_config_id, name, description = null, traits = {} }) {
    return this.createDna({
      generation_config_id,
      name,
      type: "CHARACTER",
      description,
      traits,
    });
  }
}

export const characterRepository = new CharacterRepository();
export default characterRepository;
