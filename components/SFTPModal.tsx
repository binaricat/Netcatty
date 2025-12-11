import {
  ArrowUp,
  ChevronRight,
  Database,
  Download,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  FileVideo,
  Folder,
  Globe,
  Home,
  Key,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Settings,
  Terminal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/utils";
import { Host, RemoteFile } from "../types";
import { DistroAvatar } from "./DistroAvatar";
import { Button } from "./ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";

// Comprehensive file icon helper
const getFileIcon = (fileName: string, isDirectory: boolean) => {
  if (isDirectory)
    return (
      <Folder
        size={18}
        fill="currentColor"
        fillOpacity={0.2}
        className="text-blue-400"
      />
    );

  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  const iconClass = "text-muted-foreground";

  // Documents
  if (["doc", "docx", "rtf", "odt"].includes(ext))
    return <FileText size={18} className="text-blue-500" />;
  if (["xls", "xlsx", "csv", "ods"].includes(ext))
    return <FileSpreadsheet size={18} className="text-green-500" />;
  if (["ppt", "pptx", "odp"].includes(ext))
    return <FileType size={18} className="text-orange-500" />;
  if (["pdf"].includes(ext))
    return <FileText size={18} className="text-red-500" />;

  // Code/Scripts
  if (["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(ext))
    return <FileCode size={18} className="text-yellow-500" />;
  if (["py", "pyc", "pyw"].includes(ext))
    return <FileCode size={18} className="text-blue-400" />;
  if (["sh", "bash", "zsh", "fish", "bat", "cmd", "ps1"].includes(ext))
    return <Terminal size={18} className="text-green-400" />;
  if (["c", "cpp", "h", "hpp", "cc", "cxx"].includes(ext))
    return <FileCode size={18} className="text-blue-600" />;
  if (["java", "class", "jar"].includes(ext))
    return <FileCode size={18} className="text-orange-600" />;
  if (["go"].includes(ext))
    return <FileCode size={18} className="text-cyan-500" />;
  if (["rs"].includes(ext))
    return <FileCode size={18} className="text-orange-400" />;
  if (["rb"].includes(ext))
    return <FileCode size={18} className="text-red-400" />;
  if (["php"].includes(ext))
    return <FileCode size={18} className="text-purple-500" />;
  if (["html", "htm", "xhtml"].includes(ext))
    return <Globe size={18} className="text-orange-500" />;
  if (["css", "scss", "sass", "less"].includes(ext))
    return <FileCode size={18} className="text-blue-500" />;
  if (["vue", "svelte"].includes(ext))
    return <FileCode size={18} className="text-green-500" />;

  // Config/Data
  if (["json", "json5"].includes(ext))
    return <FileCode size={18} className="text-yellow-600" />;
  if (["xml", "xsl", "xslt"].includes(ext))
    return <FileCode size={18} className="text-orange-400" />;
  if (["yml", "yaml"].includes(ext))
    return <Settings size={18} className="text-pink-400" />;
  if (["toml", "ini", "conf", "cfg", "config"].includes(ext))
    return <Settings size={18} className="text-gray-400" />;
  if (["env"].includes(ext))
    return <Lock size={18} className="text-yellow-500" />;
  if (["sql", "sqlite", "db"].includes(ext))
    return <Database size={18} className="text-blue-400" />;

  // Images
  if (
    [
      "jpg",
      "jpeg",
      "png",
      "gif",
      "bmp",
      "webp",
      "svg",
      "ico",
      "tiff",
      "tif",
      "heic",
      "heif",
      "avif",
    ].includes(ext)
  )
    return <FileImage size={18} className="text-purple-400" />;

  // Videos
  if (
    [
      "mp4",
      "mkv",
      "avi",
      "mov",
      "wmv",
      "flv",
      "webm",
      "m4v",
      "3gp",
      "mpeg",
      "mpg",
    ].includes(ext)
  )
    return <FileVideo size={18} className="text-pink-500" />;

  // Audio
  if (
    ["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "opus", "aiff"].includes(
      ext,
    )
  )
    return <FileAudio size={18} className="text-green-400" />;

  // Archives
  if (
    [
      "zip",
      "rar",
      "7z",
      "tar",
      "gz",
      "bz2",
      "xz",
      "tgz",
      "tbz2",
      "lz",
      "lzma",
      "cab",
      "iso",
      "dmg",
    ].includes(ext)
  )
    return <FileArchive size={18} className="text-amber-500" />;

  // Executables
  if (["exe", "msi", "app", "deb", "rpm", "apk", "ipa"].includes(ext))
    return <File size={18} className="text-red-400" />;
  if (["dll", "so", "dylib"].includes(ext))
    return <File size={18} className="text-gray-500" />;

  // Keys/Certs
  if (["pem", "crt", "cer", "key", "pub", "ppk"].includes(ext))
    return <Key size={18} className="text-yellow-400" />;

  // Text/Markdown
  if (["md", "markdown", "mdx"].includes(ext))
    return <FileText size={18} className="text-gray-400" />;
  if (["txt", "log", "text"].includes(ext))
    return <FileText size={18} className={iconClass} />;

  // Default
  return <File size={18} className={iconClass} />;
};

// Format bytes with appropriate unit (B, KB, MB, GB)
const formatBytes = (bytes: number | string): string => {
  const numBytes = typeof bytes === "string" ? parseInt(bytes, 10) : bytes;
  if (isNaN(numBytes) || numBytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(numBytes) / Math.log(1024));
  const size = numBytes / Math.pow(1024, i);
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

// Format date as YYYY-MM-DD HH:mm:ss in local timezone
const formatDate = (dateStr: string | number | undefined): string => {
  if (!dateStr) return "--";
  const date =
    typeof dateStr === "number" ? new Date(dateStr) : new Date(dateStr);
  if (isNaN(date.getTime())) return String(dateStr);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

interface SFTPModalProps {
  host: Host;
  credentials: {
    username?: string;
    hostname: string;
    port?: number;
    password?: string;
    privateKey?: string;
  };
  open: boolean;
  onClose: () => void;
}

// Sort configuration
type SortField = "name" | "size" | "modified";
type SortOrder = "asc" | "desc";

// Transfer task type for modal
interface UploadTask {
  id: string;
  fileName: string;
  status: "pending" | "uploading" | "completed" | "failed";
  progress: number;
  totalBytes: number;
  transferredBytes: number;
  speed: number; // bytes per second
  startTime: number;
  error?: string;
}

const SFTPModal: React.FC<SFTPModalProps> = ({
  host,
  credentials,
  open,
  onClose,
}) => {
  const [currentPath, setCurrentPath] = useState("/");
  const [files, setFiles] = useState<RemoteFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(false);
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const sftpIdRef = useRef<string | null>(null);
  const initializedRef = useRef(false);
  const navigatingRef = useRef(false);
  const lastSelectedIndexRef = useRef<number | null>(null);

  // Sorting state
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");

  // Column widths (percentages)
  const [columnWidths, setColumnWidths] = useState({
    name: 45,
    size: 15,
    modified: 25,
    actions: 15,
  });
  const resizingRef = useRef<{
    field: string;
    startX: number;
    startWidth: number;
  } | null>(null);

  // Editable path state
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [editingPathValue, setEditingPathValue] = useState("");
  const pathInputRef = useRef<HTMLInputElement>(null);

  const ensureSftp = async () => {
    if (sftpIdRef.current) return sftpIdRef.current;
    if (!window.nebula?.openSftp) throw new Error("SFTP bridge unavailable");
    const sftpId = await window.nebula.openSftp({
      sessionId: `sftp-modal-${host.id}`,
      hostname: credentials.hostname,
      username: credentials.username || "root",
      port: credentials.port || 22,
      password: credentials.password,
      privateKey: credentials.privateKey,
    });
    sftpIdRef.current = sftpId;
    return sftpId;
  };

  const loadFiles = useCallback(async (path: string) => {
    try {
      setError(null);
      const sftpId = await ensureSftp();
      setLoading(true);
      const list = await window.nebula.listSftp(sftpId, path);
      setFiles(list);
      setSelectedFiles(new Set());
    } catch (e) {
      console.error("Failed to load files", e);
      setError(e instanceof Error ? e.message : "Failed to load directory");
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const closeSftp = async () => {
    if (sftpIdRef.current && window.nebula?.closeSftp) {
      try {
        await window.nebula.closeSftp(sftpIdRef.current);
      } catch {}
    }
    sftpIdRef.current = null;
  };

  useEffect(() => {
    return () => {
      // Cleanup on unmount
      closeSftp();
    };
  }, []);

  useEffect(() => {
    if (open) {
      if (!initializedRef.current) {
        initializedRef.current = true;
        setCurrentPath("/");
      }
      loadFiles(currentPath);
    } else {
      closeSftp();
      initializedRef.current = false;
    }
  }, [open, currentPath, loadFiles]);

  const handleNavigate = useCallback((path: string) => {
    // Prevent double navigation (e.g., from double-click race condition)
    if (navigatingRef.current) return;
    navigatingRef.current = true;
    setCurrentPath(path);
    // Reset lock after a short delay
    setTimeout(() => {
      navigatingRef.current = false;
    }, 300);
  }, []);

  const handleUp = () => {
    if (currentPath === "/") return;
    const parent = currentPath.split("/").slice(0, -1).join("/") || "/";
    setCurrentPath(parent);
  };

  const handleDownload = async (file: RemoteFile) => {
    try {
      const sftpId = await ensureSftp();
      const fullPath =
        currentPath === "/" ? `/${file.name}` : `${currentPath}/${file.name}`;
      setLoading(true);
      const content = await window.nebula.readSftp(sftpId, fullPath);
      const blob = new Blob([content], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setLoading(false);
    }
  };

  const handleUploadFile = async (
    file: File,
    taskId: string,
  ): Promise<boolean> => {
    const sftpId = await ensureSftp();
    const startTime = Date.now();

    // Update task to uploading with start time
    setUploadTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? {
              ...t,
              status: "uploading" as const,
              totalBytes: file.size,
              startTime,
              speed: 0,
            }
          : t,
      ),
    );

    try {
      const arrayBuffer = await file.arrayBuffer();
      const fullPath =
        currentPath === "/" ? `/${file.name}` : `${currentPath}/${file.name}`;

      // Use real-time progress API if available
      if (window.nebula.writeSftpBinaryWithProgress) {
        await window.nebula.writeSftpBinaryWithProgress(
          sftpId,
          fullPath,
          arrayBuffer,
          taskId,
          // Real-time progress callback
          (transferred: number, total: number, speed: number) => {
            const progress =
              total > 0 ? Math.round((transferred / total) * 100) : 0;
            setUploadTasks((prev) =>
              prev.map((t) =>
                t.id === taskId && t.status === "uploading"
                  ? {
                      ...t,
                      transferredBytes: transferred,
                      progress,
                      speed,
                    }
                  : t,
              ),
            );
          },
          // Complete callback
          () => {
            const totalTime = (Date.now() - startTime) / 1000;
            const finalSpeed = totalTime > 0 ? file.size / totalTime : 0;
            setUploadTasks((prev) =>
              prev.map((t) =>
                t.id === taskId
                  ? {
                      ...t,
                      status: "completed" as const,
                      progress: 100,
                      transferredBytes: file.size,
                      speed: finalSpeed,
                    }
                  : t,
              ),
            );
          },
          // Error callback
          (error: string) => {
            setUploadTasks((prev) =>
              prev.map((t) =>
                t.id === taskId
                  ? {
                      ...t,
                      status: "failed" as const,
                      error,
                    }
                  : t,
              ),
            );
          },
        );
        return true;
      } else if (window.nebula.writeSftpBinary) {
        // Fallback to non-progress API
        await window.nebula.writeSftpBinary(sftpId, fullPath, arrayBuffer);
      } else {
        // Fallback: read as text (works for text files)
        const text = await file.text();
        await window.nebula.writeSftp(sftpId, fullPath, text);
      }

      // Calculate final speed (for fallback methods)
      const totalTime = (Date.now() - startTime) / 1000;
      const finalSpeed = totalTime > 0 ? file.size / totalTime : 0;

      // Update task to completed
      setUploadTasks((prev) =>
        prev.map((t) =>
          t.id === taskId
            ? {
                ...t,
                status: "completed" as const,
                progress: 100,
                transferredBytes: file.size,
                speed: finalSpeed,
              }
            : t,
        ),
      );
      return true;
    } catch (e) {
      setUploadTasks((prev) =>
        prev.map((t) =>
          t.id === taskId
            ? {
                ...t,
                status: "failed" as const,
                error: e instanceof Error ? e.message : "Upload failed",
              }
            : t,
        ),
      );
      return false;
    }
  };

  const handleUploadMultiple = async (fileList: FileList) => {
    if (fileList.length === 0) return;

    // Create all tasks upfront
    const newTasks: UploadTask[] = Array.from(fileList).map((file) => ({
      id: crypto.randomUUID(),
      fileName: file.name,
      status: "pending" as const,
      progress: 0,
      totalBytes: file.size,
      transferredBytes: 0,
      speed: 0,
      startTime: 0,
    }));

    setUploadTasks((prev) => [...prev, ...newTasks]);
    setUploading(true);

    // Upload files sequentially
    const filesToUpload = Array.from(fileList);
    for (let i = 0; i < filesToUpload.length; i++) {
      await handleUploadFile(filesToUpload[i], newTasks[i].id);
    }

    setUploading(false);
    await loadFiles(currentPath);

    // Auto-clear completed tasks after 3 seconds
    setTimeout(() => {
      setUploadTasks((prev) => prev.filter((t) => t.status !== "completed"));
    }, 3000);
  };

  const handleDelete = async (file: RemoteFile) => {
    if (!confirm(`Delete "${file.name}"?`)) return;
    try {
      const sftpId = await ensureSftp();
      const fullPath =
        currentPath === "/" ? `/${file.name}` : `${currentPath}/${file.name}`;
      // Use deleteSftp which handles both files and directories
      if (window.nebula.deleteSftp) {
        await window.nebula.deleteSftp(sftpId, fullPath);
      }
      await loadFiles(currentPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const handleCreateFolder = async () => {
    const folderName = prompt("New folder name?");
    if (!folderName) return;
    try {
      const sftpId = await ensureSftp();
      const fullPath =
        currentPath === "/" ? `/${folderName}` : `${currentPath}/${folderName}`;
      await window.nebula.mkdirSftp(sftpId, fullPath);
      await loadFiles(currentPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create folder");
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleUploadMultiple(e.target.files);
    }
    // Reset input so same file can be selected again
    e.target.value = "";
  };

  // Drag and Drop handlers
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleUploadMultiple(e.dataTransfer.files);
    }
  };

  const handleClose = async () => {
    await closeSftp();
    setIsEditingPath(false);
    onClose();
  };

  // Sorted files
  const sortedFiles = useMemo(() => {
    return [...files].sort((a, b) => {
      // Directories always first
      if (a.type === "directory" && b.type !== "directory") return -1;
      if (a.type !== "directory" && b.type === "directory") return 1;

      let cmp = 0;
      switch (sortField) {
        case "name":
          cmp = a.name.localeCompare(b.name);
          break;
        case "size": {
          const sizeA =
            typeof a.size === "number"
              ? a.size
              : parseInt(String(a.size), 10) || 0;
          const sizeB =
            typeof b.size === "number"
              ? b.size
              : parseInt(String(b.size), 10) || 0;
          cmp = sizeA - sizeB;
          break;
        }
        case "modified": {
          const dateA = new Date(a.lastModified || 0).getTime();
          const dateB = new Date(b.lastModified || 0).getTime();
          cmp = dateA - dateB;
          break;
        }
      }
      return sortOrder === "asc" ? cmp : -cmp;
    });
  }, [files, sortField, sortOrder]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortOrder("asc");
    }
  };

  // Column resize handlers
  const handleResizeStart = (field: string, e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = {
      field,
      startX: e.clientX,
      startWidth: columnWidths[field as keyof typeof columnWidths],
    };
    document.addEventListener("mousemove", handleResizeMove);
    document.addEventListener("mouseup", handleResizeEnd);
  };

  const handleResizeMove = useCallback((e: MouseEvent) => {
    if (!resizingRef.current) return;
    const diff = e.clientX - resizingRef.current.startX;
    const newWidth = Math.max(
      10,
      Math.min(60, resizingRef.current.startWidth + diff / 5),
    );
    setColumnWidths((prev) => ({
      ...prev,
      [resizingRef.current!.field]: newWidth,
    }));
  }, []);

  const handleResizeEnd = useCallback(() => {
    resizingRef.current = null;
    document.removeEventListener("mousemove", handleResizeMove);
    document.removeEventListener("mouseup", handleResizeEnd);
  }, [handleResizeMove]);

  // Path editing handlers
  const handlePathDoubleClick = () => {
    setEditingPathValue(currentPath);
    setIsEditingPath(true);
    setTimeout(() => pathInputRef.current?.select(), 0);
  };

  const handlePathSubmit = () => {
    const newPath = editingPathValue.trim() || "/";
    setIsEditingPath(false);
    if (newPath !== currentPath) {
      handleNavigate(newPath.startsWith("/") ? newPath : `/${newPath}`);
    }
  };

  const handlePathKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handlePathSubmit();
    } else if (e.key === "Escape") {
      setIsEditingPath(false);
    }
  };

  // Breadcrumbs
  const breadcrumbs =
    currentPath === "/" ? [] : currentPath.split("/").filter(Boolean);

  const handleFileClick = (
    file: RemoteFile,
    index: number,
    e: React.MouseEvent,
  ) => {
    if (file.type === "directory") {
      // Double click to enter directory is handled by onDoubleClick
      // Single click just selects
      if (e.shiftKey && lastSelectedIndexRef.current !== null) {
        // Shift-click: range select
        const start = Math.min(lastSelectedIndexRef.current, index);
        const end = Math.max(lastSelectedIndexRef.current, index);
        const newSelection = new Set<string>();
        for (let i = start; i <= end; i++) {
          if (files[i] && files[i].type !== "directory") {
            newSelection.add(files[i].name);
          }
        }
        setSelectedFiles(newSelection);
      } else if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd click: toggle selection
        setSelectedFiles((prev) => {
          const next = new Set(prev);
          // Don't select directories
          return next;
        });
      }
      return;
    }

    // For files
    if (e.shiftKey && lastSelectedIndexRef.current !== null) {
      // Shift-click: range select
      const start = Math.min(lastSelectedIndexRef.current, index);
      const end = Math.max(lastSelectedIndexRef.current, index);
      const newSelection = new Set<string>();
      for (let i = start; i <= end; i++) {
        if (files[i] && files[i].type !== "directory") {
          newSelection.add(files[i].name);
        }
      }
      setSelectedFiles(newSelection);
    } else if (e.ctrlKey || e.metaKey) {
      // Ctrl/Cmd click: toggle selection
      setSelectedFiles((prev) => {
        const next = new Set(prev);
        if (next.has(file.name)) {
          next.delete(file.name);
        } else {
          next.add(file.name);
        }
        return next;
      });
      lastSelectedIndexRef.current = index;
    } else {
      // Normal click: single select
      setSelectedFiles(new Set([file.name]));
      lastSelectedIndexRef.current = index;
    }
  };

  const handleFileDoubleClick = (file: RemoteFile) => {
    if (file.type === "directory") {
      handleNavigate(
        currentPath === "/" ? `/${file.name}` : `${currentPath}/${file.name}`,
      );
    } else {
      handleDownload(file);
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedFiles.size === 0) return;
    const fileNames = Array.from(selectedFiles);
    if (
      !confirm(
        `Delete ${fileNames.length} item${fileNames.length > 1 ? "s" : ""}?`,
      )
    )
      return;

    try {
      const sftpId = await ensureSftp();
      for (const fileName of fileNames) {
        const fullPath =
          currentPath === "/" ? `/${fileName}` : `${currentPath}/${fileName}`;
        if (window.nebula.deleteSftp) {
          await window.nebula.deleteSftp(sftpId, fullPath);
        }
      }
      await loadFiles(currentPath);
      setSelectedFiles(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const handleDownloadSelected = async () => {
    if (selectedFiles.size === 0) return;
    for (const fileName of selectedFiles) {
      const file = files.find((f) => f.name === fileName);
      if (file && file.type === "file") {
        await handleDownload(file);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && handleClose()}>
      <DialogContent className="max-w-4xl h-[80vh] flex flex-col p-0 gap-0">
        {/* Header */}
        <DialogHeader className="px-4 py-3 border-b border-border/60 flex-shrink-0">
          <div className="flex items-center gap-3 pr-8">
            <DistroAvatar
              host={host}
              fallback={host.label.slice(0, 2).toUpperCase()}
              className="h-8 w-8"
            />
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-sm font-semibold">
                {host.label}
              </DialogTitle>
              <div className="text-xs text-muted-foreground font-mono">
                {credentials.username || "root"}@{credentials.hostname}:
                {credentials.port || 22}
              </div>
            </div>
          </div>
        </DialogHeader>

        {/* Toolbar */}
        <div className="px-4 py-2 border-b border-border/60 flex items-center gap-2 flex-shrink-0 bg-muted/30">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleUp}
            disabled={currentPath === "/"}
          >
            <ArrowUp size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setCurrentPath("/")}
          >
            <Home size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => loadFiles(currentPath)}
          >
            <RefreshCw size={14} className={cn(loading && "animate-spin")} />
          </Button>

          {/* Editable Breadcrumbs */}
          <div className="flex items-center gap-1 text-sm flex-1 min-w-0 overflow-hidden">
            {isEditingPath ? (
              <Input
                ref={pathInputRef}
                value={editingPathValue}
                onChange={(e) => setEditingPathValue(e.target.value)}
                onBlur={handlePathSubmit}
                onKeyDown={handlePathKeyDown}
                className="h-7 text-sm bg-background"
                autoFocus
              />
            ) : (
              <div
                className="flex items-center gap-1 flex-1 min-w-0 cursor-text hover:bg-secondary/50 rounded px-1 py-0.5 transition-colors"
                onDoubleClick={handlePathDoubleClick}
                title="Double-click to edit path"
              >
                <button
                  className="text-muted-foreground hover:text-foreground px-1"
                  onClick={() => setCurrentPath("/")}
                >
                  /
                </button>
                {breadcrumbs.map((part, idx) => (
                  <React.Fragment key={idx}>
                    <ChevronRight
                      size={12}
                      className="text-muted-foreground flex-shrink-0"
                    />
                    <button
                      className="text-muted-foreground hover:text-foreground truncate px-1"
                      onClick={() =>
                        setCurrentPath(
                          "/" + breadcrumbs.slice(0, idx + 1).join("/"),
                        )
                      }
                    >
                      {part}
                    </button>
                  </React.Fragment>
                ))}
              </div>
            )}
          </div>

          {/* Action buttons moved here */}
          <div className="flex items-center gap-2 ml-auto">
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
            >
              <Upload size={14} className="mr-1.5" /> Upload
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={handleCreateFolder}
            >
              <Plus size={14} className="mr-1.5" /> New Folder
            </Button>
            <input
              type="file"
              className="hidden"
              ref={inputRef}
              onChange={handleFileSelect}
              multiple
            />
          </div>
        </div>

        {/* Error display */}
        {error && (
          <div className="px-4 py-2 bg-destructive/10 text-destructive text-xs border-b border-destructive/20 flex items-center justify-between">
            <span>{error}</span>
            <button className="ml-2 underline" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        {/* File List */}
        <div
          className={cn(
            "flex-1 overflow-y-auto relative",
            dragActive && "bg-primary/5 ring-2 ring-inset ring-primary",
          )}
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
        >
          {dragActive && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
              <div className="bg-background/95 p-6 rounded-xl shadow-lg border-2 border-dashed border-primary text-primary font-medium flex flex-col items-center gap-2">
                <Upload size={32} />
                <span>Drop files to upload</span>
              </div>
            </div>
          )}

          {loading && files.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/80">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          )}

          {files.length === 0 && !loading && (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <Folder size={48} className="mb-3 opacity-50" />
              <div className="text-sm font-medium">Empty Directory</div>
              <div className="text-xs mt-1">
                Drag and drop files here to upload
              </div>
            </div>
          )}

          {/* Table Header with sortable columns and resize handles */}
          {files.length > 0 && (
            <div
              className="sticky top-0 bg-muted/80 backdrop-blur-sm border-b border-border/60 px-4 py-2 flex items-center text-xs font-medium text-muted-foreground select-none"
              style={{
                display: "grid",
                gridTemplateColumns: `${columnWidths.name}% ${columnWidths.size}% ${columnWidths.modified}% ${columnWidths.actions}%`,
              }}
            >
              <div
                className="flex items-center gap-1 cursor-pointer hover:text-foreground relative pr-2"
                onClick={() => handleSort("name")}
              >
                <span>Name</span>
                {sortField === "name" && (
                  <span className="text-primary">
                    {sortOrder === "asc" ? "↑" : "↓"}
                  </span>
                )}
                <div
                  className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors"
                  onMouseDown={(e) => handleResizeStart("name", e)}
                />
              </div>
              <div
                className="flex items-center gap-1 cursor-pointer hover:text-foreground relative pr-2"
                onClick={() => handleSort("size")}
              >
                <span>Size</span>
                {sortField === "size" && (
                  <span className="text-primary">
                    {sortOrder === "asc" ? "↑" : "↓"}
                  </span>
                )}
                <div
                  className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors"
                  onMouseDown={(e) => handleResizeStart("size", e)}
                />
              </div>
              <div
                className="flex items-center gap-1 cursor-pointer hover:text-foreground relative pr-2"
                onClick={() => handleSort("modified")}
              >
                <span>Modified</span>
                {sortField === "modified" && (
                  <span className="text-primary">
                    {sortOrder === "asc" ? "↑" : "↓"}
                  </span>
                )}
                <div
                  className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/50 transition-colors"
                  onMouseDown={(e) => handleResizeStart("modified", e)}
                />
              </div>
              <div className="text-right">Actions</div>
            </div>
          )}

          {/* File rows */}
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="divide-y divide-border/30">
                {sortedFiles.map((file, idx) => (
                  <ContextMenu key={idx}>
                    <ContextMenuTrigger>
                      <div
                        className={cn(
                          "px-4 py-2.5 items-center hover:bg-muted/50 cursor-pointer transition-colors text-sm",
                          selectedFiles.has(file.name) && "bg-primary/10",
                        )}
                        style={{
                          display: "grid",
                          gridTemplateColumns: `${columnWidths.name}% ${columnWidths.size}% ${columnWidths.modified}% ${columnWidths.actions}%`,
                        }}
                        onClick={(e) => handleFileClick(file, idx, e)}
                        onDoubleClick={() => handleFileDoubleClick(file)}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="shrink-0">
                            {getFileIcon(file.name, file.type === "directory")}
                          </div>
                          <span className="truncate font-medium">
                            {file.name}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {file.type === "directory"
                            ? "--"
                            : formatBytes(file.size)}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {formatDate(file.lastModified)}
                        </div>
                        <div className="flex items-center justify-end gap-1">
                          {file.type === "file" && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDownload(file);
                              }}
                              title="Download"
                            >
                              <Download size={14} />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 hover:text-destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDelete(file);
                            }}
                            title="Delete"
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      {file.type === "directory" && (
                        <ContextMenuItem
                          onClick={() =>
                            handleNavigate(
                              currentPath === "/"
                                ? `/${file.name}`
                                : `${currentPath}/${file.name}`,
                            )
                          }
                        >
                          Open
                        </ContextMenuItem>
                      )}
                      {file.type === "file" && (
                        <ContextMenuItem onClick={() => handleDownload(file)}>
                          <Download size={14} className="mr-2" /> Download
                        </ContextMenuItem>
                      )}
                      <ContextMenuItem
                        className="text-destructive"
                        onClick={() => handleDelete(file)}
                      >
                        <Trash2 size={14} className="mr-2" /> Delete
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                ))}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={handleCreateFolder}>
                <Plus className="h-4 w-4 mr-2" /> New folder
              </ContextMenuItem>
              <ContextMenuItem onClick={() => inputRef.current?.click()}>
                <Upload className="h-4 w-4 mr-2" /> Upload files
              </ContextMenuItem>
              <ContextMenuItem onClick={() => loadFiles(currentPath)}>
                <RefreshCw className="h-4 w-4 mr-2" /> Refresh
              </ContextMenuItem>
              {selectedFiles.size > 0 && (
                <>
                  <ContextMenuItem onClick={handleDownloadSelected}>
                    <Download className="h-4 w-4 mr-2" /> Download selected (
                    {selectedFiles.size})
                  </ContextMenuItem>
                  <ContextMenuItem
                    className="text-destructive"
                    onClick={handleDeleteSelected}
                  >
                    <Trash2 className="h-4 w-4 mr-2" /> Delete selected (
                    {selectedFiles.size})
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>
        </div>

        {/* Upload progress at bottom */}
        {uploadTasks.length > 0 && (
          <div className="border-t border-border/60 bg-secondary/50 flex-shrink-0">
            <div className="max-h-40 overflow-y-auto">
              {uploadTasks.map((task) => {
                // Format speed
                const formatSpeed = (bytesPerSec: number) => {
                  if (bytesPerSec <= 0) return "";
                  if (bytesPerSec >= 1024 * 1024)
                    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
                  if (bytesPerSec >= 1024)
                    return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
                  return `${Math.round(bytesPerSec)} B/s`;
                };

                // Format bytes
                const formatBytes = (bytes: number) => {
                  if (bytes === 0) return "0 B";
                  if (bytes >= 1024 * 1024)
                    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
                  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
                  return `${bytes} B`;
                };

                // Remaining time
                const remainingBytes = task.totalBytes - task.transferredBytes;
                const remainingTime =
                  task.speed > 0 ? Math.ceil(remainingBytes / task.speed) : 0;
                const remainingStr =
                  remainingTime > 60
                    ? `~${Math.ceil(remainingTime / 60)}m left`
                    : remainingTime > 0
                      ? `~${remainingTime}s left`
                      : "";

                return (
                  <div
                    key={task.id}
                    className="px-4 py-2.5 flex items-center gap-3 border-b border-border/30 last:border-b-0"
                  >
                    <div className="shrink-0">
                      {task.status === "uploading" && (
                        <Loader2
                          size={14}
                          className="animate-spin text-primary"
                        />
                      )}
                      {task.status === "pending" && (
                        <Upload
                          size={14}
                          className="text-muted-foreground animate-pulse"
                        />
                      )}
                      {task.status === "completed" && (
                        <Upload size={14} className="text-green-500" />
                      )}
                      {task.status === "failed" && (
                        <X size={14} className="text-destructive" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium truncate">
                          {task.fileName}
                        </span>
                        {task.status === "uploading" && task.speed > 0 && (
                          <span className="text-[10px] text-primary font-mono shrink-0">
                            {formatSpeed(task.speed)}
                          </span>
                        )}
                        {task.status === "uploading" && remainingStr && (
                          <span className="text-[10px] text-muted-foreground shrink-0">
                            {remainingStr}
                          </span>
                        )}
                      </div>
                      {(task.status === "uploading" ||
                        task.status === "pending") && (
                        <div className="mt-1.5 flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
                            <div
                              className={cn(
                                "h-full rounded-full transition-all duration-150",
                                task.status === "pending"
                                  ? "bg-muted-foreground/50 animate-pulse w-full"
                                  : "bg-primary",
                              )}
                              style={{
                                width:
                                  task.status === "uploading"
                                    ? `${task.progress}%`
                                    : undefined,
                              }}
                            />
                          </div>
                          <span className="text-[10px] text-muted-foreground font-mono shrink-0 w-8 text-right">
                            {task.status === "uploading"
                              ? `${task.progress}%`
                              : "..."}
                          </span>
                        </div>
                      )}
                      {task.status === "uploading" && task.totalBytes > 0 && (
                        <div className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                          {formatBytes(task.transferredBytes)} /{" "}
                          {formatBytes(task.totalBytes)}
                        </div>
                      )}
                      {task.status === "completed" && (
                        <div className="text-[10px] text-green-600 mt-0.5">
                          Completed • {formatBytes(task.totalBytes)}
                        </div>
                      )}
                      {task.status === "failed" && task.error && (
                        <div className="text-[10px] text-destructive truncate mt-0.5">
                          {task.error}
                        </div>
                      )}
                    </div>
                    <div className="text-[10px] text-muted-foreground shrink-0">
                      {task.status === "pending" && "Waiting..."}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-4 py-2 border-t border-border/60 flex items-center justify-between text-xs text-muted-foreground bg-muted/30 flex-shrink-0">
          <span>
            {files.length} items
            {selectedFiles.size > 0 && (
              <>
                <span className="mx-2">•</span>
                <span className="text-primary">
                  {selectedFiles.size} selected
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-2 ml-2 text-xs text-primary hover:text-primary"
                  onClick={handleDownloadSelected}
                >
                  <Download size={10} className="mr-1" /> Download
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 px-2 text-xs text-destructive hover:text-destructive"
                  onClick={handleDeleteSelected}
                >
                  <Trash2 size={10} className="mr-1" /> Delete
                </Button>
              </>
            )}
          </span>
          <span>
            {loading ? "Loading..." : uploading ? "Uploading..." : "Ready"}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default SFTPModal;
