import { useRef } from "react";
import { logger } from "./logger";

// Set to true to enable render tracking logs (for debugging only)
const DEBUG_RENDER_TRACKING = false;

/**
 * 追踪组件渲染次数和原因
 * 在开发环境下帮助识别不必要的重渲染
 * 
 * @param componentName 组件名称
 * @param props 当前 props（用于比较变化）
 * @param enabled 是否启用追踪，默认 false（需要调试时手动启用）
 */
export function useRenderTracker(
  componentName: string,
  props: Record<string, unknown>,
  enabled: boolean = DEBUG_RENDER_TRACKING
): void {
  const renderCountRef = useRef(0);
  const prevPropsRef = useRef<Record<string, unknown>>({});

  renderCountRef.current += 1;

  if (!enabled) return;

  const renderCount = renderCountRef.current;
  const prevProps = prevPropsRef.current;

  // 找出变化的 props
  const changedProps: string[] = [];
  const allKeys = new Set([...Object.keys(props), ...Object.keys(prevProps)]);

  for (const key of allKeys) {
    if (prevProps[key] !== props[key]) {
      changedProps.push(key);
    }
  }

  // 只在有变化时打印（减少日志噪音）
  if (renderCount === 1) {
    logger.info(`[Render] ${componentName} - 首次渲染`);
  } else if (changedProps.length > 0) {
    logger.info(`[Render] ${componentName} - 第${renderCount}次渲染`, {
      changedProps,
      details: changedProps.reduce((acc, key) => {
        acc[key] = {
          prev: summarizeValue(prevProps[key]),
          curr: summarizeValue(props[key]),
        };
        return acc;
      }, {} as Record<string, { prev: string; curr: string }>),
    });
  }
  // 不再打印 "props未变化" 的警告 - 这是正常的 React 行为

  // 更新 prevProps
  prevPropsRef.current = { ...props };
}

/**
 * 简化值的显示，避免日志过长
 */
function summarizeValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "function") return `fn:${value.name || "anonymous"}`;
  if (typeof value === "object") {
    if (Array.isArray(value)) return `Array(${value.length})`;
    const keys = Object.keys(value);
    if (keys.length <= 3) {
      return `{${keys.join(", ")}}`;
    }
    return `Object(${keys.length} keys)`;
  }
  if (typeof value === "string" && value.length > 30) {
    return `"${value.slice(0, 30)}..."`;
  }
  return String(value);
}
