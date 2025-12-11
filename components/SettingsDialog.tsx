import {
  Check,
  Cloud,
  Download,
  Github,
  Loader2,
  Moon,
  Palette,
  Sun,
  TerminalSquare,
  Upload,
} from "lucide-react";
import React, { useState } from "react";
import { Host, SSHKey, Snippet } from "../domain/models";
import { TERMINAL_THEMES } from "../infrastructure/config/terminalThemes";
import {
  loadFromGist,
  syncToGist,
} from "../infrastructure/services/syncService";
import { cn } from "../lib/utils";
import { SyncConfig } from "../types";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { ScrollArea } from "./ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Textarea } from "./ui/textarea";

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (data: string) => void;
  exportData: () => unknown;
  theme: "dark" | "light";
  onThemeChange: (theme: "dark" | "light") => void;
  primaryColor: string;
  onPrimaryColorChange: (color: string) => void;
  syncConfig: SyncConfig | null;
  onSyncConfigChange: (config: SyncConfig | null) => void;
  terminalThemeId: string;
  onTerminalThemeChange: (id: string) => void;
}

const COLORS = [
  { name: "Blue", value: "221.2 83.2% 53.3%" },
  { name: "Violet", value: "262.1 83.3% 57.8%" },
  { name: "Rose", value: "346.8 77.2% 49.8%" },
  { name: "Orange", value: "24.6 95% 53.1%" },
  { name: "Green", value: "142.1 76.2% 36.3%" },
];

const SettingsDialog: React.FC<SettingsDialogProps> = ({
  isOpen,
  onClose,
  onImport,
  exportData,
  theme,
  onThemeChange,
  primaryColor,
  onPrimaryColorChange,
  syncConfig,
  onSyncConfigChange,
  terminalThemeId,
  onTerminalThemeChange,
}) => {
  const [importText, setImportText] = useState("");

  // Sync State
  const [githubToken, setGithubToken] = useState(syncConfig?.githubToken || "");
  const [gistId, setGistId] = useState(syncConfig?.gistId || "");
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<"idle" | "success" | "error">(
    "idle",
  );

  const handleManualExport = () => {
    const dataStr =
      "data:text/json;charset=utf-8," +
      encodeURIComponent(JSON.stringify(exportData(), null, 2));
    const downloadAnchorNode = document.createElement("a");
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "nebula_backup.json");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  };

  const handleManualImport = () => {
    try {
      JSON.parse(importText);
      onImport(importText);
      alert("Configuration imported successfully!");
      setImportText("");
    } catch (_e) {
      alert("Invalid JSON format.");
    }
  };

  const handleSaveSyncConfig = async () => {
    if (!githubToken) return;

    setIsSyncing(true);
    setSyncStatus("idle");
    try {
      if (gistId) {
        await loadFromGist(githubToken, gistId);
      }
      onSyncConfigChange({ githubToken, gistId });
      setSyncStatus("success");
    } catch (e) {
      console.error(e);
      setSyncStatus("error");
      alert("Failed to verify Gist or Token.");
    } finally {
      setIsSyncing(false);
    }
  };

  const performSyncUpload = async () => {
    if (!githubToken) return;
    setIsSyncing(true);
    try {
      const data = exportData() as {
        keys: SSHKey[];
        hosts: Host[];
        snippets: Snippet[];
        customGroups: string[];
      };
      const newGistId = await syncToGist(
        githubToken,
        gistId || undefined,
        data,
      );
      if (!gistId) {
        setGistId(newGistId);
        onSyncConfigChange({
          githubToken,
          gistId: newGistId,
          lastSync: Date.now(),
        });
      } else {
        onSyncConfigChange({ ...syncConfig!, lastSync: Date.now() });
      }
      alert("Backup uploaded to Gist successfully!");
    } catch (e) {
      alert("Upload failed: " + e);
    } finally {
      setIsSyncing(false);
    }
  };

  const performSyncDownload = async () => {
    if (!githubToken || !gistId) return;
    setIsSyncing(true);
    try {
      const data = await loadFromGist(githubToken, gistId);
      onImport(JSON.stringify(data));
      onSyncConfigChange({ ...syncConfig!, lastSync: Date.now() });
      alert("Configuration restored from Gist!");
    } catch (e) {
      alert("Download failed: " + e);
    } finally {
      setIsSyncing(false);
    }
  };

  const getHslStyle = (hsl: string) => ({ backgroundColor: `hsl(${hsl})` });

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl p-0 h-[600px] gap-0 overflow-hidden flex flex-row">
        <DialogHeader className="sr-only">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Configure appearance, terminal theme, sync and data options.
          </DialogDescription>
        </DialogHeader>
        <Tabs
          defaultValue="appearance"
          orientation="vertical"
          className="flex-1 flex h-full"
        >
          {/* Sidebar using TabsList */}
          <div className="w-64 border-r bg-muted/20 p-4 flex flex-col gap-2 shrink-0 h-full">
            <h2 className="text-lg font-bold px-2 mb-2">Settings</h2>
            <TabsList className="flex flex-col h-auto bg-transparent gap-1 p-0 justify-start">
              <TabsTrigger
                value="appearance"
                className="w-full justify-start gap-3 px-3 py-2 data-[state=active]:bg-background"
              >
                <Palette size={16} /> Appearance
              </TabsTrigger>
              <TabsTrigger
                value="terminal"
                className="w-full justify-start gap-3 px-3 py-2 data-[state=active]:bg-background"
              >
                <TerminalSquare size={16} /> Terminal
              </TabsTrigger>
              <TabsTrigger
                value="sync"
                className="w-full justify-start gap-3 px-3 py-2 data-[state=active]:bg-background"
              >
                <Cloud size={16} /> Sync & Cloud
              </TabsTrigger>
              <TabsTrigger
                value="data"
                className="w-full justify-start gap-3 px-3 py-2 data-[state=active]:bg-background"
              >
                <Download size={16} /> Data Management
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Content Area */}
          <ScrollArea className="flex-1 h-full">
            <div className="p-8">
              <TabsContent
                value="appearance"
                className="space-y-8 mt-0 border-0"
              >
                <section>
                  <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4">
                    UI Theme
                  </h3>
                  <div className="grid grid-cols-2 gap-4 max-w-sm">
                    <ThemeCard
                      active={theme === "light"}
                      onClick={() => onThemeChange("light")}
                      icon={<Sun size={24} className="text-orange-500" />}
                      label="Light"
                    />
                    <ThemeCard
                      active={theme === "dark"}
                      onClick={() => onThemeChange("dark")}
                      icon={<Moon size={24} className="text-blue-400" />}
                      label="Dark"
                    />
                  </div>
                </section>

                <div className="h-px bg-border" />

                <section>
                  <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4">
                    Accent Color
                  </h3>
                  <div className="flex flex-wrap gap-4">
                    {COLORS.map((c) => (
                      <button
                        key={c.name}
                        onClick={() => onPrimaryColorChange(c.value)}
                        className={cn(
                          "w-12 h-12 rounded-full flex items-center justify-center transition-all shadow-sm",
                          primaryColor === c.value
                            ? "ring-2 ring-offset-2 ring-foreground scale-110"
                            : "hover:scale-105",
                        )}
                        style={getHslStyle(c.value)}
                        title={c.name}
                      >
                        {primaryColor === c.value && (
                          <Check
                            className="text-white drop-shadow-md"
                            size={18}
                          />
                        )}
                      </button>
                    ))}
                  </div>
                </section>
              </TabsContent>

              <TabsContent value="terminal" className="space-y-6 mt-0 border-0">
                <div>
                  <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4">
                    Terminal Themes
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {TERMINAL_THEMES.map((t) => (
                      <div
                        key={t.id}
                        onClick={() => onTerminalThemeChange(t.id)}
                        className={cn(
                          "cursor-pointer border-2 rounded-lg p-3 flex items-center gap-4 transition-all hover:bg-muted/10",
                          terminalThemeId === t.id
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-primary/50",
                        )}
                      >
                        {/* Mini Terminal Preview */}
                        <div
                          className="w-24 h-16 rounded border flex flex-col p-1.5 gap-1 shrink-0 shadow-sm"
                          style={{
                            backgroundColor: t.colors.background,
                            borderColor: t.colors.selection,
                          }}
                        >
                          <div
                            className="w-12 h-1.5 rounded-full"
                            style={{
                              backgroundColor: t.colors.foreground,
                              opacity: 0.3,
                            }}
                          />
                          <div className="flex gap-1">
                            <div
                              className="w-6 h-1.5 rounded-full"
                              style={{ backgroundColor: t.colors.blue }}
                            />
                            <div
                              className="w-8 h-1.5 rounded-full"
                              style={{ backgroundColor: t.colors.green }}
                            />
                          </div>
                          <div
                            className="w-3 h-3 mt-auto rounded-sm"
                            style={{ backgroundColor: t.colors.cursor }}
                          />
                        </div>

                        <div>
                          <div className="font-semibold text-sm">{t.name}</div>
                          <div className="flex gap-1 mt-1.5">
                            {[
                              t.colors.black,
                              t.colors.red,
                              t.colors.green,
                              t.colors.blue,
                            ].map((c, i) => (
                              <div
                                key={i}
                                className="w-2 h-2 rounded-full"
                                style={{ backgroundColor: c }}
                              />
                            ))}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </TabsContent>

              <TabsContent
                value="sync"
                className="space-y-6 max-w-lg mt-0 border-0"
              >
                <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4 text-sm text-blue-500 flex gap-3">
                  <Github className="shrink-0 mt-0.5" size={18} />
                  <div>
                    <h4 className="font-semibold mb-1">GitHub Gist Sync</h4>
                    <p className="opacity-90">
                      Backup and sync your hosts, keys, and snippets across
                      devices securely using a private GitHub Gist.
                    </p>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="grid gap-2">
                    <Label>GitHub Personal Access Token</Label>
                    <Input
                      type="password"
                      placeholder="ghp_xxxxxxxxxxxx"
                      value={githubToken}
                      onChange={(e) => setGithubToken(e.target.value)}
                      className="font-mono"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Token needs <code>gist</code> scope.
                    </p>
                  </div>
                  <div className="grid gap-2">
                    <Label>Gist ID (Optional)</Label>
                    <Input
                      placeholder="Leave empty to create new"
                      value={gistId}
                      onChange={(e) => setGistId(e.target.value)}
                      className="font-mono"
                    />
                  </div>
                  <div className="flex justify-end pt-2">
                    <Button
                      onClick={handleSaveSyncConfig}
                      disabled={isSyncing}
                      className="w-full sm:w-auto"
                    >
                      {isSyncing && (
                        <Loader2 className="animate-spin mr-2 h-4 w-4" />
                      )}
                      {syncStatus === "success"
                        ? "Verified & Saved"
                        : "Verify Connection"}
                    </Button>
                  </div>
                </div>

                {syncConfig?.githubToken && (
                  <>
                    <div className="h-px bg-border" />
                    <div className="grid grid-cols-2 gap-4">
                      <Button
                        variant="outline"
                        className="h-auto py-4 flex flex-col gap-2"
                        onClick={performSyncUpload}
                        disabled={isSyncing}
                      >
                        <Upload size={20} />
                        <span>Upload Backup</span>
                      </Button>
                      <Button
                        variant="outline"
                        className="h-auto py-4 flex flex-col gap-2"
                        onClick={performSyncDownload}
                        disabled={isSyncing}
                      >
                        <Download size={20} />
                        <span>Restore Backup</span>
                      </Button>
                    </div>
                    {syncConfig.lastSync && (
                      <p className="text-xs text-center text-muted-foreground">
                        Last Sync:{" "}
                        {new Date(syncConfig.lastSync).toLocaleString()}
                      </p>
                    )}
                  </>
                )}
              </TabsContent>

              <TabsContent
                value="data"
                className="space-y-6 max-w-lg mt-0 border-0"
              >
                <div className="p-5 border rounded-lg bg-card hover:bg-muted/20 transition-colors">
                  <h4 className="font-medium mb-2 flex items-center gap-2">
                    <Download size={16} /> Export Data
                  </h4>
                  <p className="text-sm text-muted-foreground mb-4">
                    Download a JSON file containing all your hosts, keys, and
                    snippets.
                  </p>
                  <Button
                    size="sm"
                    onClick={handleManualExport}
                    variant="outline"
                  >
                    Download JSON
                  </Button>
                </div>

                <div className="p-5 border rounded-lg bg-card hover:bg-muted/20 transition-colors">
                  <h4 className="font-medium mb-2 flex items-center gap-2">
                    <Upload size={16} /> Import Data
                  </h4>
                  <p className="text-sm text-muted-foreground mb-4">
                    Restore your configuration from a previously exported JSON
                    file.
                  </p>
                  <Textarea
                    placeholder="Paste JSON content here..."
                    className="h-24 font-mono text-xs mb-3 resize-none bg-muted/50"
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                  />
                  <Button
                    size="sm"
                    onClick={handleManualImport}
                    disabled={!importText}
                  >
                    Import JSON
                  </Button>
                </div>
              </TabsContent>
            </div>
          </ScrollArea>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
};

interface ThemeCardProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}

const ThemeCard = ({ active, onClick, icon, label }: ThemeCardProps) => (
  <div
    onClick={onClick}
    className={cn(
      "cursor-pointer rounded-xl border-2 p-6 flex flex-col items-center gap-4 transition-all duration-200 bg-card",
      active
        ? "border-primary bg-primary/5 ring-1 ring-primary/20"
        : "border-muted hover:border-primary/50",
    )}
  >
    <div
      className={cn("p-3 rounded-full bg-background", active && "shadow-sm")}
    >
      {icon}
    </div>
    <span className="text-sm font-semibold">{label}</span>
  </div>
);

export default SettingsDialog;
