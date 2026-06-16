import type {
  DockerContainerInfo,
  DockerImageInfo,
  SystemProcessInfo,
  TmuxSessionInfo,
} from './types';

export function systemProcessInfoEqual(a: SystemProcessInfo, b: SystemProcessInfo): boolean {
  return a.pid === b.pid
    && a.ppid === b.ppid
    && a.user === b.user
    && a.stat === b.stat
    && a.cpuPercent === b.cpuPercent
    && a.memPercent === b.memPercent
    && a.rssKb === b.rssKb
    && a.vszKb === b.vszKb
    && a.elapsed === b.elapsed
    && a.command === b.command;
}

export function tmuxSessionInfoEqual(a: TmuxSessionInfo, b: TmuxSessionInfo): boolean {
  return a.name === b.name
    && a.windows === b.windows
    && a.attached === b.attached
    && a.created === b.created
    && a.activity === b.activity
    && a.group === b.group;
}

export function dockerContainerInfoEqual(a: DockerContainerInfo, b: DockerContainerInfo): boolean {
  return a.id === b.id
    && a.name === b.name
    && a.image === b.image
    && a.status === b.status
    && a.state === b.state
    && a.ports === b.ports
    && a.createdAt === b.createdAt;
}

export function dockerImageInfoEqual(a: DockerImageInfo, b: DockerImageInfo): boolean {
  return a.id === b.id
    && a.repository === b.repository
    && a.tag === b.tag
    && a.name === b.name
    && a.size === b.size
    && a.createdAt === b.createdAt;
}
