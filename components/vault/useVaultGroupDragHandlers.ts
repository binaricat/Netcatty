import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import type { Host, ManagedSource } from "../../types";
import { toast } from "../ui/toast";

type DropTarget =
  | { kind: "root" }
  | { kind: "group"; path: string };

interface UseVaultGroupDragHandlersOptions {
  hosts: Host[];
  managedSources: ManagedSource[];
  onUnmanageSource?: (sourceId: string) => void;
  onUpdateHosts: (hosts: Host[]) => void;
  onUpdateManagedSources: (sources: ManagedSource[]) => void;
  t: (key: string, values?: Record<string, unknown>) => string;
}

export function useVaultGroupDragHandlers({
  hosts,
  managedSources,
  onUnmanageSource,
  onUpdateHosts,
  onUpdateManagedSources,
  t,
}: UseVaultGroupDragHandlersOptions) {
  const [dragOverDropTarget, setDragOverDropTarget] = useState<DropTarget | null>(null);
  
  const [confirmedDropTarget, setConfirmedDropTarget] = useState<DropTarget | null>(null);
  
  const dropTargetPulseTimeoutRef = useRef<number | null>(null);
  
  useEffect(() => {
      return () => {
        if (dropTargetPulseTimeoutRef.current !== null) {
          window.clearTimeout(dropTargetPulseTimeoutRef.current);
        }
      };
    }, []);
  
  const managedGroupPaths = useMemo(() => {
      return new Set(managedSources.map(s => s.groupName));
    }, [managedSources]);
  
  const isSameDropTarget = useCallback((a: DropTarget | null, b: DropTarget | null) => {
      if (!a || !b) return a === b;
      if (a.kind !== b.kind) return false;
      if (a.kind === "root") return true;
      return a.path === b.path;
    }, []);
  
  const pulseDropTarget = useCallback((target: DropTarget) => {
      setConfirmedDropTarget(target);
      if (dropTargetPulseTimeoutRef.current !== null) {
        window.clearTimeout(dropTargetPulseTimeoutRef.current);
      }
      dropTargetPulseTimeoutRef.current = window.setTimeout(() => {
        setConfirmedDropTarget((current) => (isSameDropTarget(current, target) ? null : current));
        dropTargetPulseTimeoutRef.current = null;
      }, 900);
    }, [isSameDropTarget]);
  
  const setGroupDragOverDropTarget = useCallback((path: string | null) => {
      setDragOverDropTarget(path ? { kind: "group", path } : null);
    }, []);
  
  const moveHostToGroup = useCallback((hostId: string, groupPath: string | null) => {
      const targetGroup = groupPath || "";
      const hostToMove = hosts.find((h) => h.id === hostId);
      if (!hostToMove || (hostToMove.group || "") === targetGroup) {
        setDragOverDropTarget(null);
        return;
      }
  
      // Find the most specific (deepest) managed source that matches the target group
      const targetManagedSource = managedSources
        .filter(s => targetGroup === s.groupName || targetGroup.startsWith(s.groupName + "/"))
        .sort((a, b) => b.groupName.length - a.groupName.length)[0];
  
      onUpdateHosts(
        hosts.map((h) => {
          if (h.id !== hostId) return h;
  
          // Only SSH hosts can be managed (SSH config only supports SSH)
          const canBeManaged = !h.protocol || h.protocol === "ssh";
  
          // Sanitize label if moving to a managed group (SSH config requires no spaces in Host alias)
          let label = h.label;
          if (targetManagedSource && canBeManaged && label) {
            label = label.replace(/\s/g, '');
          }
  
          return {
            ...h,
            label,
            group: targetGroup,
            managedSourceId: (targetManagedSource && canBeManaged) ? targetManagedSource.id : undefined,
          };
        }),
      );
      setDragOverDropTarget(null);
      pulseDropTarget(groupPath ? { kind: "group", path: groupPath } : { kind: "root" });
      toast.success(
        t("vault.hosts.moveToGroup.success", {
          host: hostToMove.label,
          group: groupPath || t("vault.hosts.allHosts"),
        }),
      );
    }, [hosts, managedSources, onUpdateHosts, pulseDropTarget, t]);
  
  const getDropTargetClasses = (target: DropTarget) =>
      cn(
        isSameDropTarget(dragOverDropTarget, target) &&
          "!bg-[#e7ebf0] dark:!bg-white/[0.10]",
        isSameDropTarget(confirmedDropTarget, target) &&
          "!bg-[#dde3ea] dark:!bg-white/[0.14]",
      );
  
  const handleUnmanageGroup = useCallback((groupPath: string) => {
      const source = managedSources.find(s => s.groupName === groupPath);
      if (!source) return;
  
      // Clear managedSourceId from hosts first
      const updatedHosts = hosts.map(h =>
        h.managedSourceId === source.id
          ? { ...h, managedSourceId: undefined }
          : h
      );
      onUpdateHosts(updatedHosts);
  
      // Remove the source association without modifying the SSH config file
      // This preserves the user's file contents while stopping sync
      if (onUnmanageSource) {
        onUnmanageSource(source.id);
      } else {
        // Fallback if onUnmanageSource not available
        const updatedSources = managedSources.filter(s => s.id !== source.id);
        onUpdateManagedSources(updatedSources);
      }
  
      toast.success(t("vault.managedSource.unmanageSuccess"));
    }, [managedSources, hosts, onUpdateHosts, onUpdateManagedSources, onUnmanageSource, t]);

  return {
    getDropTargetClasses,
    handleUnmanageGroup,
    managedGroupPaths,
    moveHostToGroup,
    setDragOverDropTarget,
    setGroupDragOverDropTarget,
  };
}
