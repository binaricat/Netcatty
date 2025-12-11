import { ChevronDown, Eye, EyeOff, Key, Lock, User } from "lucide-react";
import React, { useState } from "react";
import { cn } from "../lib/utils";
import { Host, SSHKey } from "../types";
import { DistroAvatar } from "./DistroAvatar";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { ScrollArea } from "./ui/scroll-area";

interface AuthDialogProps {
  host: Host;
  keys: SSHKey[];
  onSubmit: (auth: {
    username: string;
    authMethod: "password" | "key";
    password?: string;
    keyId?: string;
    saveCredentials: boolean;
  }) => void;
  onCancel: () => void;
}

const AuthDialog: React.FC<AuthDialogProps> = ({
  host,
  keys,
  onSubmit,
  onCancel,
}) => {
  const [username, setUsername] = useState(host.username || "root");
  const [authMethod, setAuthMethod] = useState<"password" | "key">("password");
  const [password, setPassword] = useState("");
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [saveCredentials, setSaveCredentials] = useState(true);
  const [isKeySelectOpen, setIsKeySelectOpen] = useState(false);

  const _selectedKey = keys.find((k) => k.id === selectedKeyId);

  const handleSubmit = () => {
    onSubmit({
      username,
      authMethod,
      password: authMethod === "password" ? password : undefined,
      keyId: authMethod === "key" ? (selectedKeyId ?? undefined) : undefined,
      saveCredentials,
    });
  };

  const isValid =
    username.trim() &&
    ((authMethod === "password" && password.trim()) ||
      (authMethod === "key" && selectedKeyId));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[420px] max-w-[90vw] bg-background border border-border/60 rounded-2xl shadow-2xl animate-in fade-in-0 zoom-in-95 duration-200">
        {/* Header */}
        <div className="px-6 py-5 border-b border-border/50">
          <div className="flex items-center gap-3">
            <DistroAvatar
              host={host}
              fallback={host.label.slice(0, 2).toUpperCase()}
              className="h-12 w-12"
            />
            <div>
              <h2 className="text-base font-semibold">{host.label}</h2>
              <p className="text-xs text-muted-foreground font-mono">
                SSH {host.hostname}:{host.port || 22}
              </p>
            </div>
          </div>
        </div>

        {/* Progress indicator */}
        <div className="px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center">
              <User size={14} />
            </div>
            <div className="flex-1 h-0.5 bg-muted" />
            <div
              className={cn(
                "h-8 w-8 rounded-full flex items-center justify-center transition-colors",
                username.trim()
                  ? "bg-primary/20 text-primary"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {authMethod === "password" ? (
                <Lock size={14} />
              ) : (
                <Key size={14} />
              )}
            </div>
            <div className="flex-1 h-0.5 bg-muted" />
            <div className="h-8 w-8 rounded-full bg-muted text-muted-foreground flex items-center justify-center text-xs font-mono">
              {">_"}
            </div>
          </div>
        </div>

        {/* Auth method tabs */}
        <div className="px-6">
          <div className="flex gap-1 p-1 bg-secondary/80 rounded-lg border border-border/60">
            <button
              className={cn(
                "flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all",
                authMethod === "password"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary",
              )}
              onClick={() => setAuthMethod("password")}
            >
              <Lock size={14} />
              Password
            </button>
            <button
              className={cn(
                "flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all",
                authMethod === "key"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary",
              )}
              onClick={() => setAuthMethod("key")}
            >
              <Key size={14} />
              Public Key
            </button>
          </div>
        </div>

        {/* Form */}
        <div className="px-6 py-4 space-y-4">
          {/* Username field (shown when no username on host) */}
          {!host.username && (
            <div className="space-y-2">
              <Label htmlFor="auth-username">Username</Label>
              <Input
                id="auth-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="root"
                autoFocus
              />
            </div>
          )}

          {/* Password field */}
          {authMethod === "password" && (
            <div className="space-y-2">
              <Label htmlFor="auth-password">Password</Label>
              <div className="relative">
                <Input
                  id="auth-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password"
                  className="pr-10"
                  autoFocus={!!host.username}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && isValid) {
                      handleSubmit();
                    }
                  }}
                />
                <button
                  type="button"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
          )}

          {/* Key selection */}
          {authMethod === "key" && (
            <div className="space-y-2">
              <Label>Select Key</Label>
              {keys.length === 0 ? (
                <div className="text-sm text-muted-foreground p-3 border border-dashed border-border/60 rounded-lg text-center">
                  No keys available. Add keys in the Keychain section.
                </div>
              ) : (
                <div className="space-y-2">
                  {keys
                    .filter((k) => k.category === "key")
                    .slice(0, 5)
                    .map((key) => (
                      <button
                        key={key.id}
                        className={cn(
                          "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors text-left",
                          selectedKeyId === key.id
                            ? "border-primary bg-primary/5"
                            : "border-border/50 hover:bg-secondary/50",
                        )}
                        onClick={() => setSelectedKeyId(key.id)}
                      >
                        <div
                          className={cn(
                            "h-8 w-8 rounded-lg flex items-center justify-center",
                            key.source === "biometric"
                              ? "bg-purple-500/20 text-purple-500"
                              : "bg-primary/20 text-primary",
                          )}
                        >
                          <Key size={14} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">
                            {key.label}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Type {key.type}
                          </div>
                        </div>
                      </button>
                    ))}
                  {keys.filter((k) => k.category === "key").length > 5 && (
                    <Popover
                      open={isKeySelectOpen}
                      onOpenChange={setIsKeySelectOpen}
                    >
                      <PopoverTrigger asChild>
                        <Button variant="outline" className="w-full">
                          Show all keys
                          <ChevronDown size={14} className="ml-2" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-80 p-0">
                        <ScrollArea className="h-64">
                          <div className="p-2 space-y-1">
                            {keys
                              .filter((k) => k.category === "key")
                              .map((key) => (
                                <button
                                  key={key.id}
                                  className={cn(
                                    "w-full flex items-center gap-2 px-2 py-2 rounded-md text-left transition-colors",
                                    selectedKeyId === key.id
                                      ? "bg-primary/10"
                                      : "hover:bg-secondary",
                                  )}
                                  onClick={() => {
                                    setSelectedKeyId(key.id);
                                    setIsKeySelectOpen(false);
                                  }}
                                >
                                  <Key size={14} className="text-primary" />
                                  <span className="text-sm truncate">
                                    {key.label}
                                  </span>
                                  <span className="text-xs text-muted-foreground ml-auto">
                                    {key.type}
                                  </span>
                                </button>
                              ))}
                          </div>
                        </ScrollArea>
                      </PopoverContent>
                    </Popover>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border/50 flex items-center justify-between">
          <Button variant="secondary" onClick={onCancel}>
            Close
          </Button>
          <div className="flex items-center gap-2">
            <Popover>
              <PopoverTrigger asChild>
                <Button disabled={!isValid} onClick={handleSubmit}>
                  Continue & Save
                  <ChevronDown size={14} className="ml-2" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-40 p-1" align="end">
                <button
                  className="w-full px-3 py-2 text-sm text-left hover:bg-secondary rounded-md"
                  onClick={() => {
                    setSaveCredentials(false);
                    handleSubmit();
                  }}
                  disabled={!isValid}
                >
                  Continue
                </button>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AuthDialog;
