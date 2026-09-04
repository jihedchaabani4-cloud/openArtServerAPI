import { getRegistry } from "../registry/loader.js";
import {
  UnknownModelFamilyError,
  UnknownOperationError,
  NoServableDeploymentError,
  ConfigIntegrityError,
} from "../errors/index.js";

export function resolveServableDeployment(modelFamily, operation, { preferredDeployment = null } = {}) {
  const { families, deployments } = getRegistry();
  const effectiveFamily = (!families.has(modelFamily) && modelFamily === "nano_banana_pro") ? "nanobana_pro" : modelFamily;

  if (!families.has(effectiveFamily)) {
    throw new UnknownModelFamilyError(modelFamily);
  }

  if (preferredDeployment) {
    const dep = deployments.get(preferredDeployment);
    if (!dep) {
      throw new NoServableDeploymentError(modelFamily, operation);
    }
    if (!dep.operations || !dep.operations[operation]) {
      throw new UnknownOperationError(modelFamily, operation);
    }
    return dep;
  }

  // Check if operation exists in any deployment for this modelFamily
  let operationExists = false;
  const servable = [];

  for (const dep of deployments.values()) {
    if (dep.modelFamily === effectiveFamily && dep.operations && dep.operations[operation]) {
      operationExists = true;
      if (["active", "deprecated"].includes(dep.status)) {
        servable.push(dep);
      }
    }
  }

  if (!operationExists) {
    throw new UnknownOperationError(modelFamily, operation);
  }

  if (servable.length === 0) {
    throw new NoServableDeploymentError(modelFamily, operation);
  }

  if (servable.length > 1) {
    throw new ConfigIntegrityError(
      `Multiple servable deployments (${servable.map((d) => d.id).join(", ")}) for ("${modelFamily}", "${operation}")`
    );
  }

  return servable[0];
}
