import * as React from "react"
import { useLayoutEffect, useState, useRef, useCallback } from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"

import { cn } from "../../lib/utils"

const Popover = PopoverPrimitive.Root

const PopoverTrigger = PopoverPrimitive.Trigger

const PopoverAnchor = PopoverPrimitive.Anchor

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, ...props }, ref) => {
  // Fix for Electron: ensure position is calculated after content is fully rendered
  const [isPositioned, setIsPositioned] = useState(false)
  const [node, setNode] = useState<HTMLDivElement | null>(null)

  // Use callback ref to detect when element is mounted
  const callbackRef = useCallback((element: HTMLDivElement | null) => {
    setNode(element)
    // Forward ref
    if (typeof ref === 'function') {
      ref(element)
    } else if (ref) {
      ref.current = element
    }
  }, [ref])

  useLayoutEffect(() => {
    if (!node) {
      setIsPositioned(false)
      return
    }
    // Element just mounted, wait for next frame to ensure position is calculated
    setIsPositioned(false)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setIsPositioned(true)
      })
    })
  }, [node])

  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={callbackRef}
        align={align}
        sideOffset={sideOffset}
        // Force position recalculation on every animation frame
        updatePositionStrategy="always"
        avoidCollisions={true}
        collisionPadding={8}
        style={{
          visibility: isPositioned ? 'visible' : 'hidden',
        }}
        className={cn(
          "z-[999999] w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none pointer-events-auto",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          className
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
})
PopoverContent.displayName = PopoverPrimitive.Content.displayName

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor }