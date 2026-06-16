/** Sanitize Docker container/image IDs — must match electron/bridges/systemManager/dockerOps.cjs */
export function sanitizeDockerContainerId(id: string): string {
  return String(id || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 64);
}

const CLEAR_STARTUP_OUTPUT = "printf '\\033[H\\033[2J\\033[3J';";

function shQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function buildDockerCommandWithSudoFallback(containerId: string, dockerArgs: string): string {
  const plainCommand = `docker ${dockerArgs}`;
  const sudoCommand = `sudo ${plainCommand}`;
  const script = [
    CLEAR_STARTUP_OUTPUT,
    `_nc_docker_err=$(docker inspect ${containerId} 2>&1 >/dev/null);`,
    '_nc_docker_status=$?;',
    `if [ "$_nc_docker_status" -eq 0 ]; then exec ${plainCommand}; fi;`,
    '_nc_docker_lc=$(printf \'%s\' "$_nc_docker_err" | tr \'[:upper:]\' \'[:lower:]\');',
    'case "$_nc_docker_lc" in',
    [
      '*permission\\ denied*docker\\ daemon*',
      '*docker\\ daemon*permission\\ denied*',
      '*permission\\ denied*docker.sock*',
      '*docker.sock*permission\\ denied*',
      '*permission\\ denied*/var/run/docker.sock*',
      '*/var/run/docker.sock*permission\\ denied*',
      '*permission\\ denied*connect\\ to\\ the\\ docker\\ daemon*',
      '*connect\\ to\\ the\\ docker\\ daemon*permission\\ denied*',
    ].join('|') + `) exec ${sudoCommand} ;;`,
    '*) printf \'%s\\n\' "$_nc_docker_err" >&2; exit "$_nc_docker_status" ;;',
    'esac',
  ].join(' ');
  return `sh -c ${shQuote(script)}`;
}

/** Interactive shell into a container — prefer bash, fall back to sh. */
export function buildDockerExecShellCommand(containerId: string): string {
  const safeId = sanitizeDockerContainerId(containerId);
  if (!safeId) return 'echo "Invalid container id"';
  return buildDockerCommandWithSudoFallback(
    safeId,
    `exec -it ${safeId} sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`,
  );
}

export function buildDockerLogsCommand(containerId: string): string {
  const safeId = sanitizeDockerContainerId(containerId);
  if (!safeId) return 'echo "Invalid container id"';
  return buildDockerCommandWithSudoFallback(safeId, `logs -f --tail 200 ${safeId}`);
}
