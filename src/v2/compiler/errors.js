export class CompilationError extends Error {
  /**
   * @param {string} rule
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(rule, message, details = {}) {
    super(message);
    this.name = "CompilationError";
    this.rule = rule;
    this.details = details;
  }

  toJSON() {
    return { rule: this.rule, message: this.message, details: this.details };
  }
}

/**
 * @param {CompilationError[]} errors
 */
export function throwCompilationErrors(errors) {
  if (errors.length > 0) {
    const err = new Error(`Workflow compilation failed with ${errors.length} error(s).`);
    err.name = "CompilationFailed";
    /** @type {any} */ (err).errors = errors.map((e) => e.toJSON());
    throw err;
  }
}
