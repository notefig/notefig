import type { Workflow } from "../workflow";
import { feedbackWorkflow } from "./feedback";

/** Every intake workflow the service runs. Add new ones here. */
export const workflows: readonly Workflow[] = [feedbackWorkflow];

export function findWorkflow(id: string): Workflow | undefined {
  return workflows.find((workflow) => workflow.id === id);
}
