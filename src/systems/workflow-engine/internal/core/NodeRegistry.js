import { WorkflowValidationError, WorkflowNotFoundError } from "../errors.js";

/**
 * NodeRegistry (Standalone Workflow Engine Core)
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

  register(nodeDef) {
    if (this._frozen) {
      throw new WorkflowValidationError("Cannot register node: NodeRegistry is frozen");
    }

    if (!nodeDef || typeof nodeDef !== "object") {
      throw new WorkflowValidationError("Invalid node definition: must be an object");
    }

    const { type, INPUT_TYPES, RETURN_TYPES, execute } = nodeDef;

    if (!type || typeof type !== "string" || !/^(base|custom)\.[a-z0-9_]+$/.test(type)) {
      throw new WorkflowValidationError(
        `Invalid node type "${type}": must match "base.<name>" or "custom.<name>"`
      );
    }

    if (this.nodes.has(type)) {
      throw new WorkflowValidationError(`Node type "${type}" is already registered`);
    }

    if (typeof execute !== "function") {
      throw new WorkflowValidationError(`Node "${type}" must define an async execute(inputs, ctx) function`);
    }

    if (!INPUT_TYPES || typeof INPUT_TYPES !== "object") {
      throw new WorkflowValidationError(`Node "${type}" must define INPUT_TYPES`);
    }

    if (!RETURN_TYPES || typeof RETURN_TYPES !== "object") {
      throw new WorkflowValidationError(`Node "${type}" must define RETURN_TYPES`);
    }

    const normalized = Object.freeze({
      category: "general",
      OUTPUT_NODE: false,
      estimateCost: () => 0,
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

  registerAll(nodeDefs = []) {
    for (const def of nodeDefs) {
      this.register(def);
    }
    return this;
  }

  freeze() {
    this._frozen = true;
    return this;
  }

  isFrozen() {
    return this._frozen;
  }

  has(type) {
    return this.nodes.has(type);
  }

  get(type) {
    const def = this.nodes.get(type);
    if (!def) {
      throw new WorkflowNotFoundError(`Node type "${type}" is not registered in NodeRegistry`, {
        resourceId: type,
      });
    }
    return def;
  }

  list() {
    return Array.from(this.nodes.values());
  }
}

export default NodeRegistry;
