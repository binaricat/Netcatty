import type {
  DockerContainerInfo,
  DockerImageInfo,
  ListeningPortInfo,
  SystemdUnitInfo,
  SystemProcessInfo,
  TmuxSessionInfo,
  ZellijSessionInfo,
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

export function zellijSessionInfoEqual(a: ZellijSessionInfo, b: ZellijSessionInfo): boolean {
  return a.name === b.name
    && a.createdText === b.createdText
    && a.attached === b.attached
    && a.exited === b.exited
    && a.isCurrent === b.isCurrent;
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

export function listeningPortInfoEqual(a: ListeningPortInfo, b: ListeningPortInfo): boolean {
  return a.id === b.id
    && a.protocol === b.protocol
    && a.address === b.address
    && a.port === b.port
    && a.pid === b.pid
    && a.processName === b.processName;
}

export function systemdUnitInfoEqual(a: SystemdUnitInfo, b: SystemdUnitInfo): boolean {
  return a.name === b.name
    && a.loadState === b.loadState
    && a.activeState === b.activeState
    && a.subState === b.subState
    && a.description === b.description
    && a.scope === b.scope;
}
