import { DISK_IO_ASSIGNMENT, PARTITION_IO_ASSIGNMENT } from './disks';
import { GPU_ASSIGNMENT, THERMAL_ASSIGNMENT } from './gpu';

export const DROPBEAR_MAX_COMMAND_BYTES = 8192;

export function withPosixRemoteWatchdog(command: string, timeoutMs = 10_000): string {
  const sec = Math.max(2, Math.min(30, Math.ceil(timeoutMs / 1000)));
  return `( ${command} ) & pid=$!; ( sleep ${sec}; kill -9 $pid 2>/dev/null ) & wpid=$!; wait $pid; rc=$?; kill $wpid 2>/dev/null; exit $rc`;
}

const LINUX_DISK_AWK = String.raw`awk '
  $0 == "__NETCATTY_DF__" { in_df = 1; next }
  !in_df {
    on_marker = index($0, " on ");
    if (on_marker > 1) {
      mount_rest = substr($0, on_marker + 4);
      type_marker = index(mount_rest, " type ");
      if (type_marker > 1) {
        mount_point = substr(mount_rest, 1, type_marker - 1);
        filesystem_type = substr(mount_rest, type_marker + 6);
        sub(/[[:space:]].*$/, "", filesystem_type);
        mount_filesystem_types[mount_point] = filesystem_type;
      }
    }
    next
  }
  $1 == "Filesystem" { has_type = ($2 == "Type"); next }
  NF > 0 {
    source = $1;
    if (has_type) {
      filesystem_type = $2; total_kb = $3; used_kb = $4; percent = $6; mount_point = $7;
    } else {
      filesystem_type = ""; total_kb = $2; used_kb = $3; percent = $5; mount_point = $6;
    }
    if ((filesystem_type == "" || filesystem_type == "-") && (mount_point in mount_filesystem_types)) {
      filesystem_type = mount_filesystem_types[mount_point];
    }
    if (mount_point == "") next;
    if (source ~ /^\/dev\/loop/ && mount_point != "/") next;
    if (mount_point != "/" && mount_point ~ /^\/(etc|proc|sys|dev|snap)(\/|$)/) next;
    if (mount_point != "/" && source ~ /^(overlay|overlayfs)(\/|$|:)/) next;
    fstype = tolower(filesystem_type);
    source_lower = tolower(source);
    is_net = 0;
    if (fstype ~ /^fuse\.(rclone|sshfs|s3fs|gcsfuse|ufs|mergerfs|unionfs|unionfs-fuse|ceph|ceph-fuse|cephfs|glusterfs)$/) is_net = 1;
    if (fstype ~ /clouddrive/) is_net = 1;
    if (fstype ~ /^(fuse|rclone|sshfs|s3fs|gcsfuse|mergerfs|unionfs|unionfs-fuse|nfs|nfs4|cifs|smb|smb3|smbfs|afs|ceph|cephfs|glusterfs)$/) is_net = 1;
    if ((filesystem_type == "" || filesystem_type == "-") && source_lower ~ /clouddrive/) is_net = 1;
    if ((filesystem_type == "" || filesystem_type == "-") && source_lower ~ /^(fuse|fuse\..*|rclone|rclone:.*|sshfs|s3fs|gcsfuse|mergerfs|unionfs|unionfs-fuse|ceph|ceph-fuse|cephfs|gluster|glusterfs|ufs)$/) is_net = 1;
    if ((filesystem_type == "" || filesystem_type == "-") && source_lower ~ /^\/\//) is_net = 1;
    if ((filesystem_type == "" || filesystem_type == "-") && source_lower !~ /^(apfs|overlay|overlayfs):/ && source_lower ~ /^([a-z0-9._-]+|\[[0-9a-f:]+(%[a-z0-9._-]+)?\]):\//) is_net = 1;
    if (is_net) next;
    pseudo_type = (fstype != "" && fstype != "-") ? fstype : source_lower;
    if (mount_point != "/" && pseudo_type ~ /^(tmpfs|shm|devtmpfs|udev|none|proc|sysfs|cgroup|cgroup2|devpts|mqueue|hugetlbfs|debugfs|tracefs|securityfs|pstore|bpf|fusectl|configfs|ramfs|rpc_pipefs|binfmt_misc|efivarfs)$/) next;
    total = total_kb / 1048576;
    used = used_kb / 1048576;
    if (total <= 0) next;
    gsub(/%/, "", percent);
    if (percent !~ /^[0-9]+$/) percent = int(used * 100 / total + 0.5);
    metadata = source;
    if (filesystem_type != "" && filesystem_type != "-") metadata = "fs=" filesystem_type ":" source;
    printf "%s:%.6f:%.6f:%s:%s,", mount_point, used, total, percent, metadata;
  }
'`;

/**
 * Primary multi-OS stats command (Linux + macOS + FreeBSD/OpenBSD/NetBSD).
 * Collects deep Linux telemetry (full CPU breakdown, ctxt/intr/procs, Active/Slab mem,
 * PSI cpu/mem/io, net bytes+pps+errs+drops, TCP retransmits, disk I/O + IOPS + %util + qdepth,
 * open FDs, active users, pending reboot, thermals) while staying strictly < 8192 bytes!
 */
export function buildPrimaryStatsCommand(): string {
  const linux = [
    `cores=$(nproc 2>/dev/null || grep -c "^processor" /proc/cpuinfo 2>/dev/null || echo 1)`,
    // CPURAW: total idle iowait steal user system | CPUEXTRA: ctxt intr run blk | PERCORERAW: t:i,...
    `eval $(awk '/^cpu /{t=0;for(i=2;i<=NF;i++)t+=$i;u=$2+$3;s=$4+$7+$8;printf "cpuraw=\"%d %d %d %d %d %d\";",t,$5,($6+0),($9+0),u,s} /^cpu[0-9]/{t=0;for(i=2;i<=NF;i++)t+=$i;pc=pc t ":" $5 ","} /^ctxt /{cx=$2} /^intr /{ir=$2} /^procs_running /{pr=$2} /^procs_blocked /{pb=$2} END{sub(/,$/,"",pc);printf "percoreraw=\"%s\";cpuextra=\"%s %s %s %s\"",pc,cx,ir,pr,pb}' /proc/stat 2>/dev/null)`,
    // MEMINFO: total free buf cached swapTotal swapFree active slab (all MiB)
    `meminfo=$(awk '/^MemTotal:/{t=$2} /^MemFree:/{f=$2} /^Buffers:/{b=$2} /^Cached:/{c=$2} /^SReclaimable:/{s=$2} /^SwapTotal:/{st=$2} /^SwapFree:/{sf=$2} /^Active:/{ac=$2} /^Slab:/{sl=$2} END{printf "%d %d %d %d %d %d %d %d",t/1024,f/1024,b/1024,(c+s)/1024,st/1024,sf/1024,ac/1024,sl/1024}' /proc/meminfo 2>/dev/null)`,
    // PSI: cpuSome10,cpuSome60,memSome10,memSome60,memFull10,ioSome10,ioSome60,ioFull10
    `psi=$(if [ -r /proc/pressure/cpu ]; then awk 'function g(s,k,a){if(match(s,k"=[0-9.]+")){return substr(s,RSTART+length(k)+1,RLENGTH-length(k)-1)}return ""} FILENAME~/cpu$/&&/^some/{cs10=g($0,"avg10");cs60=g($0,"avg60")} FILENAME~/memory$/&&/^some/{ms10=g($0,"avg10");ms60=g($0,"avg60")} FILENAME~/memory$/&&/^full/{mf10=g($0,"avg10")} FILENAME~/io$/&&/^some/{is10=g($0,"avg10");is60=g($0,"avg60")} FILENAME~/io$/&&/^full/{if10=g($0,"avg10")} END{printf "%s,%s,%s,%s,%s,%s,%s,%s",cs10,cs60,ms10,ms60,mf10,is10,is60,if10}' /proc/pressure/cpu /proc/pressure/memory /proc/pressure/io 2>/dev/null; fi)`,
    // NET: iface:rxB:txB:rxPkt:txPkt:rxErr:rxDrop:txErr:txDrop
    `net=$(awk 'NR>2{gsub(/^[ \t]+/,"");split($0,a,":");n=a[1];if(n!="lo"&&n!~/^(veth|docker|br-)/){split(a[2],b);printf "%s:%s:%s:%s:%s:%s:%s:%s:%s,",n,b[1],b[9],b[2],b[10],b[3],b[4],b[11],b[12]}}' /proc/net/dev 2>/dev/null | sed 's/,$//')`,
    `tcpretrans=$(awk '/^Tcp:/{if(h){print $13;exit}h=1}' /proc/net/snmp 2>/dev/null)`,
    `fdnr=$(awk '{printf "%s:%s",$1,$3}' /proc/sys/fs/file-nr 2>/dev/null)`,
    `users=$(who 2>/dev/null | wc -l | tr -d ' ')`,
    `reboot=$([ -f /var/run/reboot-required ] && echo 1 || echo 0)`,
    `hv=$(hostname 2>/dev/null || uname -n 2>/dev/null)`,
    `osn=$(awk -F= '/^PRETTY_NAME=/{gsub(/"/,"",$2);print $2;exit}' /etc/os-release 2>/dev/null || uname -s 2>/dev/null)`,
    `kn=$(uname -r 2>/dev/null)`,
    `up=$(awk '{printf "%.0f",$1}' /proc/uptime 2>/dev/null)`,
    `la=$(awk '{print $1" "$2" "$3}' /proc/loadavg 2>/dev/null)`,
    DISK_IO_ASSIGNMENT,
    PARTITION_IO_ASSIGNMENT,
    THERMAL_ASSIGNMENT,
    `echo "OSFAM:linux|CPURAW:$cpuraw|CPUEXTRA:$cpuextra|CORES:$cores|PERCORERAW:$percoreraw|MEMINFO:$meminfo|PSI:$psi|NET:$net|TCPRETRANS:$tcpretrans|DISKIO:$diskio|PARTITIONIO:$partitionio|DISKMOUNTS:$diskmounts|THERMALS:$thermals|FD:$fdnr|USERS:$users|REBOOT:$reboot|HOST:$hv|OS:$osn|KERNEL:$kn|UPTIME:$up|LOAD:$la"`,
  ].join('; ');

  const macos = [
    `cores=$(sysctl -n hw.logicalcpu 2>/dev/null || echo 1)`,
    `psize=$(sysctl -n hw.pagesize 2>/dev/null || echo 4096)`,
    `msize=$(sysctl -n hw.memsize 2>/dev/null || echo 0)`,
    `cpupct=$(ps -A -o %cpu= 2>/dev/null | awk -v c="$cores" '{s+=$1} END{if(c<=0)c=1;s=s/c;if(s<0)s=0;if(s>100)s=100;printf "%.0f",s}')`,
    `vmmem=$(vm_stat 2>/dev/null | awk -v ps="$psize" '/^Pages free:/{gsub(/[^0-9]/,"",$NF);f=$NF+0} /^Pages speculative:/{gsub(/[^0-9]/,"",$NF);sp=$NF+0} /^Pages inactive:/{gsub(/[^0-9]/,"",$NF);ia=$NF+0} /^Pages purgeable:/{gsub(/[^0-9]/,"",$NF);pg=$NF+0} END{printf "%d %d",int((f+sp)*ps/1048576),int((ia+pg)*ps/1048576)}')`,
    `mt=$(echo "$msize" | awk '{printf "%d",$1/1048576}')`,
    `mf=$(echo "$vmmem" | awk '{print $1}')`,
    `mc=$(echo "$vmmem" | awk '{print $2}')`,
    `sw=$(sysctl vm.swapusage 2>/dev/null | awk '{for(i=1;i<=NF;i++){if($i=="total"&&$(i+1)=="="){v=$(i+2);m=(v~/G/?1024:1);gsub(/[MmGg]/,"",v);st=v*m}if($i=="used"&&$(i+1)=="="){v=$(i+2);m=(v~/G/?1024:1);gsub(/[MmGg]/,"",v);su=v*m}}} END{printf "%.0f %.0f",st+0,(st-su>0?st-su:0)}')`,
    `disks=$({ mount 2>/dev/null; printf "__NETCATTY_DF__\\n"; df -kP 2>/dev/null; } | awk '$0=="__NETCATTY_DF__"{d=1;next} !d{if(index($1,"/dev/disk")==1&&(index($0,"(apfs,")||index($0,"(apfs)"))){k=$1;sub(/s[0-9].*$/,"",k);cap[$1]="apfs:" k}next} $1=="Filesystem"{next} index($1,"/dev/")==1{m=$6;if(m=="/"||index(m,"/Volumes/")==1){t=$2/1048576;k=(($1 in cap)?cap[$1]:$1);if(k~/^apfs:/){u=($2-$4)/1048576;p=(t>0?int(u*100/t+0.5):0)}else{u=$3/1048576;p=$5;gsub(/%/,"",p)}printf "%s:%.6f:%.6f:%s:%s,",m,u,t,p,k}}' | sed 's/,$//')`,
    `net=$(netstat -ibn 2>/dev/null | awk 'NR==1{for(i=1;i<=NF;i++){if($i=="Ibytes")ib=i;if($i=="Obytes")ob=i}next} ib&&ob&&$1~/^[[:alpha:]]/&&$1!~/^lo/&&$0~/<Link#/{n=$1;gsub(/[*]/,"",n);rx=$(ib)+0;tx=$(ob)+0;if(rx>0||tx>0)seen[n]=rx ":" tx} END{for(n in seen)printf "%s:%s,",n,seen[n]}' | sed 's/,$//')`,
    `hv=$(hostname 2>/dev/null || uname -n 2>/dev/null)`,
    `osn=$(printf "%s %s" "$(sw_vers -productName 2>/dev/null)" "$(sw_vers -productVersion 2>/dev/null)" | sed 's/[[:space:]]*$//')`,
    `kn=$(uname -r 2>/dev/null)`,
    `bs=$(sysctl -n kern.boottime 2>/dev/null | awk -F'[ ,]+' '{for(i=1;i<=NF;i++)if($i=="sec"){print $(i+2);exit}}')`,
    `up=$(awk -v n="$(date +%s 2>/dev/null || echo 0)" -v b="$bs" 'BEGIN{if(n>0&&b>0)printf "%.0f",n-b}')`,
    `la=$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | awk '{print $1" "$2" "$3}')`,
    `users=$(who 2>/dev/null | wc -l | tr -d ' ')`,
    `echo "OSFAM:macos|CPU:$cpupct|CORES:$cores|MEMINFO:$mt $mf 0 $mc $sw|DISKS:$disks|NET:$net|USERS:$users|HOST:$hv|OS:$osn|KERNEL:$kn|UPTIME:$up|LOAD:$la"`,
  ].join('; ');

  const bsd = [
    `cores=$(sysctl -n hw.ncpu 2>/dev/null || echo 1)`,
    `cpupct=$(ps -axo %cpu= 2>/dev/null | awk -v c="$cores" '{s+=$1} END{if(c<=0)c=1;s=s/c;if(s<0)s=0;if(s>100)s=100;printf "%.0f",s}')`,
    `mt=$(sysctl -n hw.physmem 2>/dev/null | awk '{printf "%d",$1/1048576}' || echo 0)`,
    `psize=$(sysctl -n hw.pagesize 2>/dev/null || echo 4096)`,
    `mf=$(awk -v p="$(sysctl -n vm.stats.vm.v_free_count 2>/dev/null || echo 0)" -v ps="$psize" 'BEGIN{printf "%d",p*ps/1048576}')`,
    `mc=$(awk -v p="$(sysctl -n vm.stats.vm.v_inactive_count 2>/dev/null || echo 0)" -v ps="$psize" 'BEGIN{printf "%d",p*ps/1048576}')`,
    `disks=$(df -kP 2>/dev/null | awk '$1!="Filesystem"&&$1!~/^(devfs|tmpfs|procfs|fdescfs)$/{t=$2/1048576;u=$3/1048576;p=$5;gsub(/%/,"",p);if(t>0)printf "%s:%.6f:%.6f:%s:%s,",$6,u,t,p,$1}' | sed 's/,$//')`,
    `net=$(netstat -ibn 2>/dev/null | awk 'NR==1{for(i=1;i<=NF;i++){if($i=="Ibytes")ib=i;if($i=="Obytes")ob=i}next} ib&&ob&&$1!~/^lo/&&$0~/<Link#/{n=$1;gsub(/[*]/,"",n);seen[n]=($(ib)+0)":"($(ob)+0)} END{for(n in seen)printf "%s:%s,",n,seen[n]}' | sed 's/,$//')`,
    `hv=$(hostname 2>/dev/null || uname -n 2>/dev/null)`,
    `osn=$(uname -sr 2>/dev/null || echo BSD)`,
    `kn=$(uname -r 2>/dev/null)`,
    `bs=$(sysctl -n kern.boottime 2>/dev/null | awk -F'[ ,]+' '{for(i=1;i<=NF;i++)if($i=="sec"){print $(i+2);exit}}')`,
    `up=$(awk -v n="$(date +%s 2>/dev/null || echo 0)" -v b="$bs" 'BEGIN{if(n>0&&b>0)printf "%.0f",n-b}')`,
    `la=$(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}' | awk '{print $1" "$2" "$3}')`,
    `echo "OSFAM:freebsd|CPU:$cpupct|CORES:$cores|MEMINFO:$mt $mf 0 $mc 0 0|DISKS:$disks|NET:$net|HOST:$hv|OS:$osn|KERNEL:$kn|UPTIME:$up|LOAD:$la"`,
  ].join('; ');

  return `ostype=$(uname -s 2>/dev/null || echo Unknown); if [ "$ostype" = "Linux" ]; then ${linux}; elif [ "$ostype" = "Darwin" ]; then ${macos}; elif [ "$ostype" = "FreeBSD" ] || [ "$ostype" = "OpenBSD" ] || [ "$ostype" = "NetBSD" ]; then ${bsd}; else echo "UNSUPPORTED_OS:$ostype"; fi`;
}

/**
 * Separate Linux disk capacity + inode utilization command (kept distinct to stay under 8192 bytes).
 */
export function buildLinuxDiskCommand(): string {
  const diskTable = `{ LC_ALL=C mount 2>/dev/null; printf "%s\\n" "__NETCATTY_DF__"; LC_ALL=C df -kPT 2>/dev/null || LC_ALL=C df -kP 2>/dev/null; }`;
  const diskRoot = `{ LC_ALL=C mount 2>/dev/null; printf "%s\\n" "__NETCATTY_DF__"; LC_ALL=C df -kPT / 2>/dev/null || LC_ALL=C df -kP / 2>/dev/null; }`;
  const inodesCmd = `inodes=$(LC_ALL=C df -iP 2>/dev/null | awk 'NR>1 && $2 ~ /^[0-9]+$/ && $2+0 > 0 {p=$5; gsub(/%/,"",p); if(p!~/^[0-9]+$/) p=int($3*100/$2+0.5); printf "%s:%s:%s:%s,", $6, $3, $2, p}' | sed 's/,$//')`;
  return [
    `disks=$( { ${diskTable}; } | ${LINUX_DISK_AWK} | sed 's/,$//' )`,
    `[ -n "$disks" ] || disks=$( { ${diskRoot}; } | ${LINUX_DISK_AWK} | sed 's/,$//' )`,
    inodesCmd,
    `echo "DISKS:$disks|INODES:$inodes"`,
  ].join('; ');
}

export function buildGpuProbeCommand(): string {
  return `if [ "$(uname -s 2>/dev/null)" = "Linux" ]; then ${GPU_ASSIGNMENT}; echo "GPU:$gpustat"; fi`;
}

export function buildWindowsStatsCommand(): string {
  const ps = [
    `$os=Get-CimInstance Win32_OperatingSystem`,
    `$cs=Get-CimInstance Win32_ComputerSystem`,
    `$cpu=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average`,
    `$cores=[int]$cs.NumberOfLogicalProcessors`,
    `$mt=[int]([math]::Round($os.TotalVisibleMemorySize/1024))`,
    `$mf=[int]([math]::Round($os.FreePhysicalMemory/1024))`,
    `$up=[int]((Get-Date)-$os.LastBootUpTime).TotalSeconds`,
    `$disks=(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { $t=[math]::Round($_.Size/1GB,4); $u=[math]::Round(($_.Size-$_.FreeSpace)/1GB,4); $p=if($_.Size -gt 0){[int][math]::Round(($_.Size-$_.FreeSpace)*100/$_.Size)}else{0}; "$($_.DeviceID):$($u):$($t):$($p):$($_.FileSystem)" }) -join ','`,
    `Write-Output ("OSFAM:windows|CPU:{0}|CORES:{1}|MEMINFO:{2} {3} 0 0 0 0|DISKS:{4}|HOST:{5}|OS:{6}|KERNEL:{7}|UPTIME:{8}" -f ([int]$cpu),$cores,$mt,$mf,$disks,$env:COMPUTERNAME,$os.Caption,$os.Version,$up)`,
  ].join('; ');
  return `powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`;
}

export function buildProcessesCommand(limit = 150): string {
  const safeLimit = Math.max(20, Math.min(300, Math.trunc(limit)));
  return [
    `ostype=$(uname -s 2>/dev/null || echo "Linux")`,
    `if [ "$ostype" = "Darwin" ]; then ps -axo pid=,user=,%cpu=,%mem=,rss=,state=,etime=,command= 2>/dev/null | sort -k3 -rn | head -n ${safeLimit};`,
    `elif ps -eo pid=,user=,%cpu=,%mem=,rss=,stat=,etime=,args= --sort=-%cpu >/dev/null 2>&1; then ps -eo pid=,user=,%cpu=,%mem=,rss=,stat=,etime=,args= --sort=-%cpu 2>/dev/null | head -n ${safeLimit};`,
    `else ps -eo pid=,user=,%cpu=,%mem=,rss=,stat=,etime=,args= 2>/dev/null | sort -k3 -rn | head -n ${safeLimit}; fi`,
  ].join(' ');
}

export function buildServicesAndContainersCommand(): string {
  return [
    `echo "__NC_SYSTEMD__"`,
    `if command -v systemctl >/dev/null 2>&1; then LC_ALL=C systemctl list-units --type=service --all --no-pager --no-legend --plain 2>/dev/null | head -n 200; fi`,
    `echo "__NC_DOCKER__"`,
    `if command -v docker >/dev/null 2>&1; then docker ps -a --no-trunc --format '{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.State}}\\t{{.Status}}\\t{{.Ports}}' 2>/dev/null | head -n 100; fi`,
    `echo "__NC_PODMAN__"`,
    `if command -v podman >/dev/null 2>&1; then podman ps -a --no-trunc --format '{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.State}}\\t{{.Status}}\\t{{.Ports}}' 2>/dev/null | head -n 100; fi`,
  ].join('; ');
}

export function buildPortsCommand(): string {
  return [
    `echo "__NC_PORTS__"`,
    `if command -v ss >/dev/null 2>&1; then LC_ALL=C ss -tulnpH 2>/dev/null || LC_ALL=C ss -tulnH 2>/dev/null;`,
    `elif command -v netstat >/dev/null 2>&1; then LC_ALL=C netstat -tulnp 2>/dev/null || LC_ALL=C netstat -an 2>/dev/null | head -n 150;`,
    `elif command -v lsof >/dev/null 2>&1; then LC_ALL=C lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | head -n 150; fi`,
    `echo "__NC_SOCKSUMMARY__"`,
    `if command -v ss >/dev/null 2>&1; then LC_ALL=C ss -tanH 2>/dev/null | awk '{c[$1]++} END{for(k in c) printf "%s:%d\\n",k,c[k]}'; fi`,
  ].join('; ');
}

/**
 * Active-tab System & Security Audit collector (open FDs, active logged-in users,
 * recent SSH logins, failed auth count, pending reboot).
 */
export function buildSystemAuditCommand(): string {
  return [
    `echo "__NC_FD__"`,
    `awk '{printf "%s:%s\\n",$1,$3}' /proc/sys/fs/file-nr 2>/dev/null || true`,
    `echo "__NC_REBOOT__"`,
    `[ -f /var/run/reboot-required ] && echo 1 || echo 0`,
    `echo "__NC_WHO__"`,
    `LC_ALL=C who 2>/dev/null | head -n 30 || true`,
    `echo "__NC_LAST__"`,
    `LC_ALL=C last -n 8 2>/dev/null | head -n 12 || true`,
    `echo "__NC_FAILEDAUTH__"`,
    `if command -v journalctl >/dev/null 2>&1; then journalctl -u ssh -u sshd --since "24 hours ago" --no-pager 2>/dev/null | grep -cE "Failed password|Invalid user|authentication failure" || true; else echo ""; fi`,
  ].join('; ');
}

const SAFE_UNIT_NAME = /^[a-zA-Z0-9@_.:-]{1,160}$/;
const SAFE_CONTAINER_ID = /^[a-zA-Z0-9_.-]{1,128}$/;

export function buildServiceLogsCommand(unit: string, lines = 120): string {
  if (!SAFE_UNIT_NAME.test(unit)) {
    throw new Error(`Invalid systemd unit name: ${unit}`);
  }
  const safeLines = Math.max(10, Math.min(500, Math.trunc(lines)));
  return `LC_ALL=C journalctl -u '${unit}' -n ${safeLines} --no-pager --output=short-iso 2>&1`;
}

export function buildContainerLogsCommand(runtime: 'docker' | 'podman', id: string, lines = 120): string {
  if (!SAFE_CONTAINER_ID.test(id)) {
    throw new Error(`Invalid container identifier: ${id}`);
  }
  const safeLines = Math.max(10, Math.min(500, Math.trunc(lines)));
  const bin = runtime === 'podman' ? 'podman' : 'docker';
  return `${bin} logs --tail ${safeLines} --timestamps '${id}' 2>&1`;
}

export type SafeServiceAction = 'start' | 'stop' | 'restart' | 'reload';
const ALLOWED_SERVICE_ACTIONS = new Set<SafeServiceAction>(['start', 'stop', 'restart', 'reload']);

export function buildServiceActionCommand(unit: string, action: SafeServiceAction): string {
  if (!SAFE_UNIT_NAME.test(unit)) {
    throw new Error(`Invalid systemd unit name: ${unit}`);
  }
  if (!ALLOWED_SERVICE_ACTIONS.has(action)) {
    throw new Error(`Unsupported systemd action: ${action}`);
  }
  return `systemctl ${action} '${unit}' 2>&1`;
}

export type SafeContainerAction = 'start' | 'stop' | 'restart';
const ALLOWED_CONTAINER_ACTIONS = new Set<SafeContainerAction>(['start', 'stop', 'restart']);

export function buildContainerActionCommand(
  runtime: 'docker' | 'podman',
  id: string,
  action: SafeContainerAction,
): string {
  if (!SAFE_CONTAINER_ID.test(id)) {
    throw new Error(`Invalid container identifier: ${id}`);
  }
  if (!ALLOWED_CONTAINER_ACTIONS.has(action)) {
    throw new Error(`Unsupported container action: ${action}`);
  }
  const bin = runtime === 'podman' ? 'podman' : 'docker';
  return `${bin} ${action} '${id}' 2>&1`;
}

export type SafeProcessSignal = 'SIGTERM' | 'SIGKILL' | 'SIGHUP' | 'SIGINT';
const ALLOWED_SIGNALS = new Set<SafeProcessSignal>(['SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGINT']);

export function buildProcessSignalCommand(pid: number, signal: SafeProcessSignal): string {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error(`Refusing to signal invalid or init PID: ${pid}`);
  }
  if (!ALLOWED_SIGNALS.has(signal)) {
    throw new Error(`Unsupported process signal: ${signal}`);
  }
  return `kill -s ${signal} ${pid}`;
}
