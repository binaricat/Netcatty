import { Key, Lock, Plus, Save, Server, X } from "lucide-react";
import React, { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { Host, SSHKey } from "../types";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

interface HostFormProps {
  initialData?: Host | null;
  availableKeys: SSHKey[];
  groups: string[];
  onSave: (host: Host) => void;
  onCancel: () => void;
}

const HostForm: React.FC<HostFormProps> = ({
  initialData,
  availableKeys,
  groups,
  onSave,
  onCancel,
}) => {
  const [formData, setFormData] = useState<Partial<Host>>(
    initialData || {
      label: "",
      hostname: "",
      port: 22,
      username: "root",
      tags: [],
      os: "linux",
      group: "General",
      identityFileId: "",
    },
  );

  const [authType, setAuthType] = useState<"password" | "key">(
    initialData?.identityFileId ? "key" : "password",
  );

  const [tagInput, setTagInput] = useState("");

  const handleAddTag = () => {
    const tag = tagInput.trim();
    if (tag && !formData.tags?.includes(tag)) {
      setFormData((prev) => ({ ...prev, tags: [...(prev.tags || []), tag] }));
      setTagInput("");
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setFormData((prev) => ({
      ...prev,
      tags: (prev.tags || []).filter((t) => t !== tagToRemove),
    }));
  };

  const handleTagKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddTag();
    }
  };

  // Effect to ensure we have a valid auth state if switching back and forth
  useEffect(() => {
    if (authType === "password") {
      setFormData((prev) => ({ ...prev, identityFileId: "" }));
    } else if (
      authType === "key" &&
      !formData.identityFileId &&
      availableKeys.length > 0
    ) {
      // Default to first key if none selected
      setFormData((prev) => ({ ...prev, identityFileId: availableKeys[0].id }));
    }
  }, [authType, availableKeys, formData.identityFileId]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (formData.label && formData.hostname && formData.username) {
      onSave({
        ...formData,
        id: initialData?.id || crypto.randomUUID(),
        tags: formData.tags || [],
        port: formData.port || 22,
        group: formData.group || "General",
        identityFileId:
          authType === "key" ? formData.identityFileId : undefined,
        createdAt: initialData?.createdAt || Date.now(),
      } as Host);
    }
  };

  return (
    <Dialog open={true} onOpenChange={() => onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="h-5 w-5 text-primary" />
            {initialData ? "Edit Host" : "New Host"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {initialData
              ? "Update connection details for this host"
              : "Create a new SSH host entry"}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="label">Label</Label>
            <Input
              id="label"
              placeholder="My Production Server"
              value={formData.label}
              onChange={(e) =>
                setFormData({ ...formData, label: e.target.value })
              }
              required
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2 grid gap-2">
              <Label htmlFor="hostname">Hostname / IP</Label>
              <Input
                id="hostname"
                placeholder="192.168.1.1"
                value={formData.hostname}
                onChange={(e) =>
                  setFormData({ ...formData, hostname: e.target.value })
                }
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="port">Port</Label>
              <Input
                id="port"
                type="number"
                value={formData.port}
                onChange={(e) =>
                  setFormData({ ...formData, port: parseInt(e.target.value) })
                }
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                value={formData.username}
                onChange={(e) =>
                  setFormData({ ...formData, username: e.target.value })
                }
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="os">OS Type</Label>
              <Select
                value={formData.os}
                onValueChange={(val: "linux" | "windows" | "macos") =>
                  setFormData({ ...formData, os: val })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select OS" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="linux">Linux</SelectItem>
                  <SelectItem value="windows">Windows</SelectItem>
                  <SelectItem value="macos">macOS</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="group">Group</Label>
            <Input
              id="group"
              placeholder="e.g. AWS, DigitalOcean"
              value={formData.group}
              onChange={(e) =>
                setFormData({ ...formData, group: e.target.value })
              }
              list="group-suggestions"
              autoComplete="off"
            />
            <datalist id="group-suggestions">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="tags">Tags</Label>
            <div className="flex gap-2">
              <Input
                id="tags"
                placeholder="Add a tag..."
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={handleTagKeyDown}
                className="flex-1"
              />
              <Button
                type="button"
                variant="secondary"
                size="icon"
                onClick={handleAddTag}
                disabled={!tagInput.trim()}
              >
                <Plus size={16} />
              </Button>
            </div>
            {formData.tags && formData.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-1">
                {formData.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 text-primary text-xs"
                  >
                    {tag}
                    <button
                      type="button"
                      onClick={() => handleRemoveTag(tag)}
                      className="hover:bg-primary/20 rounded-full p-0.5"
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-3 pt-2">
            <Label>Authentication Method</Label>
            <div className="grid grid-cols-2 gap-4">
              <div
                className={cn(
                  "border rounded-md p-3 flex flex-col items-center justify-center gap-2 cursor-pointer transition-all hover:bg-accent/50",
                  authType === "password"
                    ? "border-primary bg-primary/5 text-primary ring-1 ring-primary"
                    : "text-muted-foreground",
                )}
                onClick={() => setAuthType("password")}
              >
                <Lock size={20} />
                <span className="text-xs font-medium">Password</span>
              </div>
              <div
                className={cn(
                  "border rounded-md p-3 flex flex-col items-center justify-center gap-2 cursor-pointer transition-all hover:bg-accent/50",
                  authType === "key"
                    ? "border-primary bg-primary/5 text-primary ring-1 ring-primary"
                    : "text-muted-foreground",
                )}
                onClick={() => setAuthType("key")}
              >
                <Key size={20} />
                <span className="text-xs font-medium">SSH Key</span>
              </div>
            </div>

            {authType === "key" && (
              <div className="animate-in fade-in zoom-in-95 duration-200">
                <Select
                  value={formData.identityFileId || ""}
                  onValueChange={(val) =>
                    setFormData({ ...formData, identityFileId: val })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select an SSH Key" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableKeys.map((key) => (
                      <SelectItem key={key.id} value={key.id}>
                        {key.label} ({key.type})
                      </SelectItem>
                    ))}
                    {availableKeys.length === 0 && (
                      <SelectItem value="none" disabled>
                        No keys available
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
                {availableKeys.length === 0 && (
                  <p className="text-[10px] text-destructive mt-1">
                    No SSH keys found in Keychain. Please create one first.
                  </p>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit">
              <Save className="mr-2 h-4 w-4" /> Save Host
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default HostForm;
