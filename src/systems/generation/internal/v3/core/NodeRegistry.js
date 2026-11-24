import { GenerationValidationError, GenerationNotFoundError } from "../../errors.js";

/**
 * NodeRegistry (ComfyUI-Style Node Engine V3)
 *
 * Registers, validates, and freezes all `base.*` and `custom.*` nodes.
 */
export class NodeRegistry {
  constructor(initialNodes = []) {
    this.nodes = new Map();
    this._frozen = false;

    if (Array.isArray(initialNodes)) {
      for (const node of initialNodes) {
        this.register(node);
      }
    }
  }

  /**
   * Validates and registers a V3 node definition.
   *
   * @param {Object} nodeDef
   * @returns {this}
   */
  register(nodeDef) {
    if (this._frozen) {
      throw new GenerationValidationError("Cannot register node: NodeRegistry is frozen");
    }

    if (!nodeDef || typeof nodeDef !== "object") {
      throw new GenerationValidationError("Invalid node definition: must be an object");
    }

    const { type, INPUT_TYPES, RETURN_TYPES, execute } = nodeDef;

    if (!type || typeof type !== "string" || !/^(base|custom)\.[a-z0-9_]+$/.test(type)) {
      throw new GenerationValidationError(
        `Invalid node type "${type}": must match "base.<name>" or "custom.<name>"`
      );
    }

    if (this.nodes.has(type)) {
      throw new GenerationValidationError(`Node type "${type}" is already registered`);
    }

    if (typeof execute !== "function") {
      throw new GenerationValidationError(`Node "${type}" must define an async execute(inputs, ctx) function`);
    }

    if (!INPUT_TYPES || typeof INPUT_TYPES !== "object") {
      throw new GenerationValidationError(`Node "${type}" must define INPUT_TYPES`);
    }

    if (!RETURN_TYPES || typeof RETURN_TYPES !== "object") {
      throw new GenerationValidationError(`Node "${type}" must define RETURN_TYPES`);
    }

    const normalized = Object.freeze({
      category: "general",
      OUTPUT_NODE: false,
      estimateCost: () => 0,
      retryPolicy: Object.freeze({
        maxAttempts: 1,
        backoffMs: 0,
        retryableCategories: ["UPSTREAM_FAULT", "RATE_LIMIT"],
      }),
      ...nodeDef,
      OUTPUT_NODE: Boolean(nodeDef.OUTPUT_NODE),
      CACHEABLE: nodeDef.CACHEABLE !== undefined ? Boolean(nodeDef.CACHEABLE) : !Boolean(nodeDef.OUTPUT_NODE),
      INPUT_TYPES: Object.freeze({
        required: Object.freeze({ ...(nodeDef.INPUT_TYPES?.required || {}) }),
        optional: Object.freeze({ ...(nodeDef.INPUT_TYPES?.optional || {}) }),
      }),
      RETURN_TYPES: Object.freeze({ ...(nodeDef.RETURN_TYPES || {}) }),
    });

    this.nodes.set(type, normalized);
    return this;
  }

  /**
   * Registers multiple nodes at once.
   *
   * @param {Array<Object>} nodeDefs
   * @returns {this}
   */
  registerAll(nodeDefs = []) {
    for (const def of nodeDefs) {
      this.register(def);
    }
    return this;
  }

  /**
   * Freezes the registry to prevent runtime mutation.
   *
   * @returns {this}
   */
  freeze() {
    this._frozen = true;
    return this;
  }

  /**
   * Checks if the registry is frozen.
   *
   * @returns {boolean}
   */
  isFrozen() {
    return this._frozen;
  }

  /**
   * Checks if a node type exists.
   *
   * @param {string} type
   * @returns {boolean}
   */
  has(type) {
    return this.nodes.has(type);
  }

  /**
   * Retrieves a registered node definition or throws if not found.
   *
   * @param {string} type
   * @returns {Object}
   */
  get(type) {
    const def = this.nodes.get(type);
    if (!def) {
      throw new GenerationNotFoundError(`Node type "${type}" is not registered in V3 NodeRegistry`, {
        resourceId: type,
      });
    }
    return def;
  }

  /**
   * Lists all registered node definitions.
   *
   * @returns {Array<Object>}
   */
  list() {
    return Array.from(this.nodes.values());
  }
}

export default NodeRegistry;
