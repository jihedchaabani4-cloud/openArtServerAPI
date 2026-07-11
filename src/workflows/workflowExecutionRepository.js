export class WorkflowExecutionRepository {
  constructor({ db = null } = {}) {
    this.db = db;
    this.memory = new Map();
  }

  async create(execution) {
    this.memory.set(execution.executionId, { ...execution });
    return this.memory.get(execution.executionId);
  }

  async update(executionId, patch) {
    const current = this.memory.get(executionId) || { executionId };
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.memory.set(executionId, next);
    return next;
  }

  async findById(executionId) {
    return this.memory.get(executionId) || null;
  }
}
