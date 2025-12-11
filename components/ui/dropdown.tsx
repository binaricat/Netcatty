import * as React from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/utils";

interface DropdownContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}

const DropdownContext = React.createContext<DropdownContextValue | null>(null);

function useDropdown() {
  const context = React.useContext(DropdownContext);
  if (!context) {
    throw new Error("Dropdown components must be used within a Dropdown");
  }
  return context;
}

interface DropdownProps {
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const Dropdown: React.FC<DropdownProps> = ({
  children,
  open: controlledOpen,
  onOpenChange,
}) => {
  const [internalOpen, setInternalOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = useCallback(
    (value: boolean) => {
      if (controlledOpen === undefined) {
        setInternalOpen(value);
      }
      onOpenChange?.(value);
    },
    [controlledOpen, onOpenChange],
  );

  return (
    <DropdownContext.Provider value={{ open, setOpen, triggerRef }}>
      {children}
    </DropdownContext.Provider>
  );
};

interface DropdownTriggerProps {
  children: React.ReactElement;
  asChild?: boolean;
}

const DropdownTrigger: React.FC<DropdownTriggerProps> = ({
  children,
  asChild,
}) => {
  const { open, setOpen, triggerRef } = useDropdown();

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen(!open);
  };

  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(
      children as React.ReactElement<{
        ref?: React.Ref<HTMLButtonElement>;
        onClick?: (e: React.MouseEvent) => void;
      }>,
      {
        ref: triggerRef,
        onClick: (e: React.MouseEvent) => {
          handleClick(e);
          const childProps = children.props as {
            onClick?: (e: React.MouseEvent) => void;
          };
          childProps?.onClick?.(e);
        },
      },
    );
  }

  return (
    <button ref={triggerRef} onClick={handleClick}>
      {children}
    </button>
  );
};

interface DropdownContentProps {
  children: React.ReactNode;
  className?: string;
  align?: "start" | "center" | "end";
  sideOffset?: number;
  side?: "top" | "bottom";
  /** If true, align to the trigger's parent element instead of the trigger itself */
  alignToParent?: boolean;
}

const DropdownContent: React.FC<DropdownContentProps> = ({
  children,
  className,
  align = "start",
  sideOffset = 4,
  side = "bottom",
  alignToParent = false,
}) => {
  const { open, setOpen, triggerRef } = useDropdown();
  const contentRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);

  // Calculate position function
  const calculatePosition = useCallback(() => {
    if (!triggerRef.current) return null;

    // Use parent element if alignToParent is true
    const anchorEl = alignToParent
      ? triggerRef.current.parentElement
      : triggerRef.current;
    if (!anchorEl) return null;

    const rect = anchorEl.getBoundingClientRect();
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const contentEl = contentRef.current;

    let top: number;
    let left: number;

    // Use trigger's bottom for vertical positioning (not parent's)
    if (side === "bottom") {
      top = triggerRect.bottom + sideOffset;
    } else {
      top = triggerRect.top - sideOffset;
    }

    // Use anchor element (parent or trigger) for horizontal positioning
    if (align === "start") {
      left = rect.left;
    } else if (align === "end") {
      left = rect.right;
      if (contentEl) {
        left = rect.right - contentEl.offsetWidth;
      }
    } else {
      left = rect.left + rect.width / 2;
      if (contentEl) {
        left -= contentEl.offsetWidth / 2;
      }
    }

    // Keep within viewport
    if (contentEl) {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      if (left + contentEl.offsetWidth > viewportWidth - 8) {
        left = viewportWidth - contentEl.offsetWidth - 8;
      }
      if (left < 8) {
        left = 8;
      }
      if (top + contentEl.offsetHeight > viewportHeight - 8) {
        top = rect.top - contentEl.offsetHeight - sideOffset;
      }
    }

    return { top, left };
  }, [align, sideOffset, side, alignToParent, triggerRef]);

  // Calculate position synchronously after DOM updates
  useLayoutEffect(() => {
    if (open) {
      // Reset position first to hide content while calculating
      setPosition(null);

      // Use double requestAnimationFrame to ensure content is fully rendered
      // First frame: content is added to DOM
      // Second frame: layout is calculated, offsetWidth is available
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const pos = calculatePosition();
          if (pos) setPosition(pos);
        });
      });
    } else {
      setPosition(null);
    }
  }, [open, calculatePosition]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        contentRef.current &&
        !contentRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };

    // Use setTimeout to avoid closing immediately on the same click that opened it
    const timeoutId = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
    }, 0);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open, setOpen, triggerRef]);

  if (!open) return null;

  return createPortal(
    <div
      ref={contentRef}
      className={cn(
        "fixed z-[999999] rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
        className,
      )}
      style={{
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        visibility: position ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
};

export { Dropdown, DropdownContent, DropdownTrigger };
