import type { Env, ProjectItem, AgentRef } from "../lib/types";
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  ensureMigrated,
} from "../lib/do-client";

/**
 * Get all projects from DO storage.
 * Triggers KV→DO migration on first call if needed.
 */
export async function getData(env: Env): Promise<ProjectItem[]> {
  await ensureMigrated(env);
  return listProjects(env);
}

/**
 * Save a single project update to DO storage.
 * No more optimistic concurrency — DO handles serialization.
 */
export async function saveProject(
  env: Env,
  id: string,
  updates: Partial<ProjectItem>
): Promise<ProjectItem | null> {
  const result = await updateProject(env, id, updates);
  return result.data ?? null;
}

/**
 * Create a new project in DO storage.
 */
export async function addProject(
  env: Env,
  item: ProjectItem
): Promise<ProjectItem | null> {
  const result = await createProject(env, item);
  return result.data ?? null;
}

/**
 * Delete a project from DO storage.
 */
export async function removeProject(
  env: Env,
  id: string
): Promise<ProjectItem | null> {
  const result = await deleteProject(env, id);
  return result.data ?? null;
}

/**
 * Get a single project from DO storage.
 */
export { getProject };

/** Add agent to contributors list if not already present */
export function addContributor(item: ProjectItem, agent: AgentRef): void {
  if (!agent?.btcAddress) return;
  if (!item.contributors) item.contributors = [];
  const exists = item.contributors.some(
    (c) => c.btcAddress === agent.btcAddress
  );
  if (!exists) {
    item.contributors.push({
      btcAddress: agent.btcAddress,
      displayName: agent.displayName,
      agentId: agent.agentId ?? null,
    });
  }
}
