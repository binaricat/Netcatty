import { AlertCircle, AlertTriangle, CheckCircle, Info, X } from 'lucide-react';
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { setNotify } from '../../application/notification';
import { cn } from '../../lib/utils';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
    id: string;
    type: ToastType;
    title?: string;
    message: string;
    duration?: number;
    onClick?: () => void;
    actionLabel?: string;
}

interface ToastContextValue {
    toasts: Toast[];
    showToast: (toast: Omit<Toast, 'id'>) => void;
    dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export const useToast = () => {
    const context = useContext(ToastContext);
    if (!context) {
        throw new Error('useToast must be used within a ToastProvider');
    }
    return context;
};

// Simple hook for components that may not be inside ToastProvider
let globalShowToast: ((toast: Omit<Toast, 'id'>) => void) | null = null;

export interface ToastOptions {
    title?: string;
    duration?: number;
    onClick?: () => void;
    actionLabel?: string;
}

export const toast = {
    success: (message: string, titleOrOptions?: string | ToastOptions) => {
        const options = typeof titleOrOptions === 'string' ? { title: titleOrOptions } : titleOrOptions;
        globalShowToast?.({ type: 'success', message, duration: 3000, ...options });
    },
    error: (message: string, titleOrOptions?: string | ToastOptions) => {
        const options = typeof titleOrOptions === 'string' ? { title: titleOrOptions } : titleOrOptions;
        globalShowToast?.({ type: 'error', message, duration: 5000, ...options });
    },
    warning: (message: string, titleOrOptions?: string | ToastOptions) => {
        const options = typeof titleOrOptions === 'string' ? { title: titleOrOptions } : titleOrOptions;
        globalShowToast?.({ type: 'warning', message, duration: 4000, ...options });
    },
    info: (message: string, titleOrOptions?: string | ToastOptions) => {
        const options = typeof titleOrOptions === 'string' ? { title: titleOrOptions } : titleOrOptions;
        globalShowToast?.({ type: 'info', message, duration: 3000, ...options });
    },
};

const TOAST_ICONS: Record<ToastType, React.ReactNode> = {
    success: <CheckCircle className="h-4 w-4 text-emerald-500" />,
    error: <AlertCircle className="h-4 w-4 text-red-500" />,
    warning: <AlertTriangle className="h-4 w-4 text-yellow-500" />,
    info: <Info className="h-4 w-4 text-blue-500" />,
};

const TOAST_STYLES: Record<ToastType, string> = {
    success: 'border-emerald-600 bg-emerald-50 dark:bg-emerald-950',
    error: 'border-red-600 bg-red-50 dark:bg-red-950',
    warning: 'border-yellow-600 bg-yellow-50 dark:bg-yellow-950',
    info: 'border-blue-600 bg-blue-50 dark:bg-blue-950',
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const showToast = useCallback((toast: Omit<Toast, 'id'>) => {
        const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const newToast: Toast = { ...toast, id };
        setToasts(prev => [...prev, newToast]);

        // Auto dismiss
        if (toast.duration !== 0) {
            setTimeout(() => {
                setToasts(prev => prev.filter(t => t.id !== id));
            }, toast.duration || 4000);
        }
    }, []);

    const dismissToast = useCallback((id: string) => {
        setToasts(prev => prev.filter(t => t.id !== id));
    }, []);

    // Register global toast function
    useEffect(() => {
        globalShowToast = showToast;
        setNotify(toast);
        return () => {
            globalShowToast = null;
        };
    }, [showToast]);

    return (
        <ToastContext.Provider value={{ toasts, showToast, dismissToast }}>
            {children}
            <ToastContainer toasts={toasts} onDismiss={dismissToast} />
        </ToastContext.Provider>
    );
};

const ToastContainer: React.FC<{ toasts: Toast[]; onDismiss: (id: string) => void }> = ({ toasts, onDismiss }) => {
    if (toasts.length === 0) return null;

    const handleToastClick = (t: Toast) => {
        if (t.onClick) {
            t.onClick();
            onDismiss(t.id);
        }
    };

    return (
        <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 max-w-sm">
            {toasts.map(t => (
                <div
                    key={t.id}
                    className={cn(
                        "flex items-start gap-3 p-3 rounded-lg border shadow-lg",
                        "bg-card animate-in slide-in-from-right-5 fade-in duration-200",
                        TOAST_STYLES[t.type],
                        t.onClick && "cursor-pointer hover:opacity-90 transition-opacity"
                    )}
                    onClick={() => handleToastClick(t)}
                    role={t.onClick ? "button" : undefined}
                    tabIndex={t.onClick ? 0 : undefined}
                >
                    <div className="flex-shrink-0 mt-0.5">
                        {TOAST_ICONS[t.type]}
                    </div>
                    <div className="flex-1 min-w-0">
                        {t.title && (
                            <div className="text-sm font-medium text-foreground">{t.title}</div>
                        )}
                        <div className="text-sm text-muted-foreground break-words">{t.message}</div>
                        {t.actionLabel && t.onClick && (
                            <div className="text-xs font-medium text-primary mt-1">{t.actionLabel} →</div>
                        )}
                    </div>
                    <button
                        onClick={(e) => { e.stopPropagation(); onDismiss(t.id); }}
                        className="flex-shrink-0 p-1 rounded hover:bg-secondary/80 transition-colors"
                    >
                        <X className="h-3.5 w-3.5 text-muted-foreground" />
                    </button>
                </div>
            ))}
        </div>
    );
};

export default ToastProvider;
