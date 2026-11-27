import { ChevronDown, User } from "lucide-react";
import React, { useMemo, useState } from "react";
import type { Identity, SSHKey } from "../../types";
import { Input } from "../ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

type Translate = (key: string, params?: Record<string, unknown>) => string;

interface IdentitySuggestInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  identities: Identity[];
  availableKeys?: SSHKey[];
  onSelectIdentity: (identity: Identity) => void;
  t: Translate;
  className?: string;
}

/**
 * Shared username input with SSH-style Keychain identity autocomplete popover.
 * Uses PopoverAnchor (never PopoverTrigger) so focus/click never races and flash-closes.
 */
export const IdentitySuggestInput: React.FC<IdentitySuggestInputProps> = ({
  value,
  onChange,
  placeholder,
  identities,
  availableKeys = [],
  onSelectIdentity,
  t,
  className,
}) => {
  const [open, setOpen] = useState(false);

  const filteredIdentities = useMemo(() => {
    const q = (value || "").toLowerCase().trim();
    if (!q) return identities;
    return identities.filter(
      (i) =>
        i.label.toLowerCase().includes(q) ||
        i.username.toLowerCase().includes(q) ||
        (i.domain && i.domain.toLowerCase().includes(q)),
    );
  }, [identities, value]);

  if (identities.length === 0) {
    return (
      <Input
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={className ?? "h-10 rounded-lg"}
      />
    );
  }

  return (
    <Popover
      open={open && filteredIdentities.length > 0}
      onOpenChange={setOpen}
    >
      <PopoverAnchor asChild>
        <div
          className="relative"
          data-identity-suggestions-anchor=""
        >
          <Input
            placeholder={placeholder}
            value={value}
            onChange={(e) => {
              const next = e.target.value;
              onChange(next);
              const q = next.toLowerCase().trim();
              const matches = q
                ? identities.filter(
                    (i) =>
                      i.label.toLowerCase().includes(q) ||
                      i.username.toLowerCase().includes(q) ||
                      (i.domain && i.domain.toLowerCase().includes(q)),
                  )
                : identities;
              setOpen(matches.length > 0);
            }}
            onFocus={() => {
              setOpen(filteredIdentities.length > 0);
            }}
            className={className ? `${className} pr-9` : "h-10 rounded-lg pr-9"}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t("hostDetails.identity.suggestions")}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => {
                  setOpen((prev) => {
                    if (prev) return false;
                    return filteredIdentities.length > 0;
                  });
                }}
              >
                <ChevronDown size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t("hostDetails.identity.suggestions")}</TooltipContent>
          </Tooltip>
        </div>
      </PopoverAnchor>
      <PopoverContent
        className="p-0 border-border/60"
        align="start"
        sideOffset={4}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          const target = e.target as Element | null;
          if (target?.closest("[data-identity-suggestions-anchor]")) {
            e.preventDefault();
          }
        }}
        style={{ width: "var(--radix-popover-trigger-width)" }}
      >
        <ScrollArea className="max-h-[280px]">
          <div className="p-1">
            {filteredIdentities.length === 0 ? (
              <div className="py-4 text-center text-sm text-muted-foreground">
                {t("common.noResultsFound")}
              </div>
            ) : (
              <div className="space-y-1">
                {filteredIdentities.map((identity) => {
                  const keyLabel = identity.keyId
                    ? availableKeys.find((k) => k.id === identity.keyId)?.label
                    : undefined;
                  const methodLabel =
                    identity.authMethod === "certificate"
                      ? t("hostDetails.credential.certificate")
                      : identity.authMethod === "key"
                        ? t("hostDetails.credential.key")
                        : t("keychain.identity.method.passwordOnly");
                  const displayUser = identity.domain
                    ? `${identity.domain}\\${identity.username}`
                    : identity.username;
                  const summaryParts = [
                    displayUser,
                    identity.password ? "******" : undefined,
                    keyLabel,
                  ].filter(Boolean);

                  return (
                    <button
                      key={identity.id}
                      type="button"
                      className="w-full flex items-center gap-3 px-3 py-2 rounded-md hover:bg-secondary/80 transition-colors text-left"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        onSelectIdentity(identity);
                        setOpen(false);
                      }}
                    >
                      <div className="h-8 w-8 rounded-md bg-green-500/15 text-green-500 flex items-center justify-center shrink-0">
                        <User size={16} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">
                          {identity.label}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {methodLabel}
                          {summaryParts.length
                            ? ` - ${summaryParts.join(", ")}`
                            : ""}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
};
