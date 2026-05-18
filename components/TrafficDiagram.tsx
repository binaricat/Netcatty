import React from 'react';
import { PortForwardingType } from '../domain/models';
import { AppLogo } from './AppLogo';

// SVG Icon components from public folder
const CloudIcon: React.FC<{ className?: string }> = ({ className }) => (
    <img src="/cloud.svg" alt="cloud" className={className} />
);

const FirewallIcon: React.FC<{ className?: string }> = ({ className }) => (
    <img src="/firewall.svg" alt="firewall" className={className} />
);

const ServerIcon: React.FC<{ className?: string }> = ({ className }) => (
    <img src="/server.svg" alt="server" className={className} />
);

// Animated diagram component for port forwarding visualization
interface TrafficDiagramProps {
    type: PortForwardingType;
    isAnimating?: boolean;
    /** Which role to highlight: 'app' | 'ssh-server' | 'target' | undefined (all visible) */
    highlightRole?: 'app' | 'ssh-server' | 'target';
}

// AppLogo is now imported from ./AppLogo to share accent color theming

// Animated line component
const AnimatedLine: React.FC<{
    x1: number; y1: number; x2: number; y2: number;
    isAnimating: boolean;
    reverse?: boolean;
    isBlocked?: boolean;
}> = ({ x1, y1, x2, y2, isAnimating, reverse = false, isBlocked = false }) => {
    if (isBlocked) {
        return <line x1={x1} y1={y1} x2={x2} y2={y2} className="stroke-destructive" strokeWidth="2.5" />;
    }
    return (
        <>
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="hsl(var(--border))" strokeWidth="2" strokeDasharray="6 4" />
            <line
                x1={x1} y1={y1} x2={x2} y2={y2}
                className="stroke-primary"
                strokeWidth="3"
                strokeDasharray="12 12"
                strokeLinecap="round"
            >
                {isAnimating && (
                    <animate
                        attributeName="stroke-dashoffset"
                        values={reverse ? "0;24" : "24;0"}
                        dur="0.6s"
                        repeatCount="indefinite"
                    />
                )}
            </line>
        </>
    );
};

export const TrafficDiagram: React.FC<TrafficDiagramProps> = ({ type, isAnimating = true, highlightRole }) => {
    // Helper to determine opacity based on highlight role
    const getOpacity = (role: 'app' | 'ssh-server' | 'target' | 'firewall') => {
        if (!highlightRole) return 'opacity-100';
        if (role === 'firewall') return 'opacity-30'; // Firewall always dimmed when highlighting
        return role === highlightRole ? 'opacity-100' : 'opacity-30';
    };

    return (
        <div className="relative w-full h-48 flex items-center justify-center overflow-hidden rounded-xl bg-secondary/60 border border-border/50">
            {/* ========== LOCAL FORWARDING ========== */}
            {type === 'local' && (
                <div className="relative w-full h-full">
                    {/* App Logo - left (same line as firewall) */}
                    <div className={`absolute left-6 top-5 z-10 transition-opacity duration-300 ${getOpacity('app')}`}>
                        <AppLogo className="h-12 w-12" />
                    </div>

                    {/* Firewall - center top (same line as app) */}
                    <div className={`absolute left-1/2 -translate-x-1/2 top-4 z-10 transition-opacity duration-300 ${getOpacity('firewall')}`}>
                        <FirewallIcon className="h-14 w-14" />
                    </div>

                    {/* Target servers - right (in red border box) */}
                    <div className={`absolute right-4 top-2 z-10 transition-opacity duration-300 ${getOpacity('target')}`}>
                        <div className="p-2 border-2 border-destructive/60 rounded-lg space-y-2">
                            <ServerIcon className="h-8 w-8" />
                            <ServerIcon className="h-8 w-8" />
                        </div>
                    </div>

                    {/* SSH Server - bottom center */}
                    <div className={`absolute left-1/2 -translate-x-1/2 bottom-4 z-10 transition-opacity duration-300 ${getOpacity('ssh-server')}`}>
                        <ServerIcon className="h-10 w-10" />
                    </div>

                    {/* SVG Lines */}
                    <svg className="absolute inset-0 w-full h-full" style={{ zIndex: 1 }}>
                        {/* App to Firewall - blocked red line (with gap) */}
                        <AnimatedLine x1={78} y1={40} x2={127} y2={40} isAnimating={false} isBlocked />
                        {/* App to SSH Server - blue animated (with gap) */}
                        <AnimatedLine x1={78} y1={58} x2={145} y2={138} isAnimating={isAnimating} />
                        {/* SSH Server to targets - blue animated (with gap) */}
                        <AnimatedLine x1={178} y1={148} x2={238} y2={58} isAnimating={isAnimating} />
                        <AnimatedLine x1={178} y1={152} x2={238} y2={88} isAnimating={isAnimating} />
                    </svg>
                </div>
            )}

            {/* ========== REMOTE FORWARDING ========== */}
            {type === 'remote' && (
                <div className="relative w-full h-full">
                    {/* Left Server - the remote SSH server where port will be opened */}
                    <div className={`absolute left-6 top-5 z-10 transition-opacity duration-300 ${getOpacity('ssh-server')}`}>
                        <ServerIcon className="h-10 w-10" />
                    </div>

                    {/* Firewall - center top */}
                    <div className={`absolute left-1/2 -translate-x-1/2 top-4 z-10 transition-opacity duration-300 ${getOpacity('firewall')}`}>
                        <FirewallIcon className="h-14 w-14" />
                    </div>

                    {/* Right Server - the destination where traffic will be forwarded */}
                    <div className={`absolute right-6 top-5 z-10 transition-opacity duration-300 ${getOpacity('target')}`}>
                        <ServerIcon className="h-10 w-10" />
                    </div>

                    {/* App Logo - bottom center (Netcatty client) */}
                    <div className={`absolute left-1/2 -translate-x-1/2 bottom-4 z-10 transition-opacity duration-300 ${getOpacity('app')}`}>
                        <AppLogo className="h-12 w-12" />
                    </div>

                    {/* SVG Lines */}
                    <svg className="absolute inset-0 w-full h-full" style={{ zIndex: 1 }}>
                        {/* Left server to Firewall - blocked (with gap) */}
                        <AnimatedLine x1={68} y1={38} x2={128} y2={38} isAnimating={false} isBlocked />
                        {/* Left server to App - blue animated (with gap) */}
                        <AnimatedLine x1={58} y1={58} x2={145} y2={135} isAnimating={isAnimating} />
                        {/* Right server to App - blue animated (with gap) */}
                        <AnimatedLine x1={262} y1={58} x2={175} y2={135} isAnimating={isAnimating} reverse />
                    </svg>
                </div>
            )}

            {/* ========== DYNAMIC FORWARDING ========== */}
            {type === 'dynamic' && (
                <div className="relative w-full h-full">
                    {/* App Logo - left (same line as firewall) */}
                    <div className={`absolute left-6 top-5 z-10 transition-opacity duration-300 ${getOpacity('app')}`}>
                        <AppLogo className="h-12 w-12" />
                    </div>

                    {/* Firewall - center top (same line as app) */}
                    <div className={`absolute left-1/2 -translate-x-1/2 top-4 z-10 transition-opacity duration-300 ${getOpacity('firewall')}`}>
                        <FirewallIcon className="h-14 w-14" />
                    </div>

                    {/* Cloud targets - right (in red border box) */}
                    <div className={`absolute right-4 top-2 z-10 transition-opacity duration-300 ${getOpacity('target')}`}>
                        <div className="p-2 border-2 border-destructive/60 rounded-lg space-y-1">
                            <CloudIcon className="h-7 w-7" />
                            <CloudIcon className="h-7 w-7" />
                            <CloudIcon className="h-7 w-7" />
                        </div>
                    </div>

                    {/* SSH Server - bottom center */}
                    <div className={`absolute left-1/2 -translate-x-1/2 bottom-4 z-10 transition-opacity duration-300 ${getOpacity('ssh-server')}`}>
                        <ServerIcon className="h-10 w-10" />
                    </div>

                    {/* Cloud target - bottom right */}
                    <div className={`absolute right-8 bottom-6 z-10 transition-opacity duration-300 ${getOpacity('target')}`}>
                        <CloudIcon className="h-8 w-8" />
                    </div>

                    {/* SVG Lines */}
                    <svg className="absolute inset-0 w-full h-full" style={{ zIndex: 1 }}>
                        {/* App to Firewall - blocked (with gap) */}
                        <AnimatedLine x1={78} y1={42} x2={128} y2={42} isAnimating={false} isBlocked />
                        {/* App to SSH Server - blue animated (with gap) */}
                        <AnimatedLine x1={78} y1={58} x2={145} y2={138} isAnimating={isAnimating} />
                        {/* SSH Server to clouds - blue animated (with gap) */}
                        <AnimatedLine x1={178} y1={142} x2={238} y2={42} isAnimating={isAnimating} />
                        <AnimatedLine x1={178} y1={148} x2={238} y2={72} isAnimating={isAnimating} />
                        <AnimatedLine x1={178} y1={155} x2={238} y2={148} isAnimating={isAnimating} />
                    </svg>
                </div>
            )}
        </div>
    );
};
