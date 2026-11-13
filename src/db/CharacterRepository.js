/**
 * Legacy Re-export for CharacterRepository.
 * Canonical implementation now lives in src/systems/characters/internal/db/CharacterRepository.js
 * accessible via #characters/tools.
 */
import { CharacterRepository, characterRepository } from "#characters/tools";

export { CharacterRepository, characterRepository };
export default characterRepository;
