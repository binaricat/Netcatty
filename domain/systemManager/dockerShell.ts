/** Sanitize Docker container/image IDs — must match electron/bridges/systemManager/dockerOps.cjs */
export function sanitizeDockerContainerId(id: string): string {
  return String(id || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 64);
}

const CLEAR_STARTUP_OUTPUT = "printf '\\033[H\\033[2J\\033[3J';";

/** Interactive shell into a container — prefer bash, fall back to sh. */
export function buildDockerExecShellCommand(containerId: string): string {
  const safeId = sanitizeDockerContainerId(containerId);
  if (!safeId) return 'echo "Invalid container id"';
  return `${CLEAR_STARTUP_OUTPUT} exec docker exec -it ${safeId} sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`;
}

export function buildDockerLogsCommand(containerId: string): string {
  const safeId = sanitizeDockerContainerId(containerId);
  if (!safeId) return 'echo "Invalid container id"';
  return `${CLEAR_STARTUP_OUTPUT} exec docker logs -f --tail 200 ${safeId}`;
}
