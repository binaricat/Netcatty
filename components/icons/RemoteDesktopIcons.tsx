import React from "react";

export interface RemoteDesktopIconProps extends React.SVGProps<SVGSVGElement> {
  size?: number | string;
}

/**
 * Expressive RDP protocol emblem: widescreen monitor frame with subtle depth
 * fill and dual opposing remote-session arrows inspired by Remote Desktop.
 */
export const RdpProtocolIcon: React.FC<RemoteDesktopIconProps> = ({
  size = 16,
  className,
  ...props
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
    {...props}
  >
    <rect
      x="2.25"
      y="3.25"
      width="19.5"
      height="13.5"
      rx="2.5"
      fill="currentColor"
      fillOpacity="0.12"
    />
    {/* Upper right-pointing arrow */}
    <path d="M8 8.25h7.5" />
    <path d="M13 5.75L15.5 8.25L13 10.75" />
    {/* Lower left-pointing arrow */}
    <path d="M16 12.25H8.5" />
    <path d="M11 9.75L8.5 12.25L11 14.75" />
    {/* Monitor stand */}
    <path d="M9.5 16.75L8.75 20.25" />
    <path d="M14.5 16.75L15.25 20.25" />
    <path d="M7.25 20.25h9.5" />
  </svg>
);

/**
 * Expressive VNC / RFB protocol emblem: layered remote framebuffer viewport
 * with dual linked displays and viewport corner reticle.
 */
export const VncProtocolIcon: React.FC<RemoteDesktopIconProps> = ({
  size = 16,
  className,
  ...props
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
    {...props}
  >
    {/* Back remote display window */}
    <path
      d="M7.5 6.25V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-1.25"
      opacity="0.65"
    />
    {/* Front active RFB viewport */}
    <rect
      x="2.5"
      y="7.25"
      width="15.25"
      height="11.25"
      rx="2.25"
      fill="currentColor"
      fillOpacity="0.12"
    />
    {/* Window titlebar bar + viewport pulse */}
    <path d="M2.75 10.75h14.75" opacity="0.55" />
    <circle cx="5.25" cy="9" r="0.6" fill="currentColor" stroke="none" />
    <circle cx="7.5" cy="9" r="0.6" fill="currentColor" stroke="none" />
    {/* Cursor / remote control triangle inside viewport */}
    <path d="M8.5 12.75L12.75 14.35L10.95 15.1L10.2 16.9L8.5 12.75Z" fill="currentColor" fillOpacity="0.28" />
    {/* Stand base */}
    <path d="M7.25 21h5.75" />
    <path d="M10.125 18.5V21" />
  </svg>
);

/**
 * Expressive JumpServer bastion emblem: faceted security shield containing a
 * bastion bridge node linking client to privileged remote target.
 */
export const JumpServerIcon: React.FC<RemoteDesktopIconProps> = ({
  size = 16,
  className,
  ...props
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
    {...props}
  >
    <path
      d="M12 2.5L4.25 5.6v5.55c0 4.95 3.3 9.2 7.75 10.6 4.45-1.4 7.75-5.65 7.75-10.6V5.6L12 2.5Z"
      fill="currentColor"
      fillOpacity="0.12"
    />
    {/* Bastion hop arc & nodes */}
    <path d="M8 13.75c0-2.5 1.75-4.5 4-4.5s4 2 4 4.5" />
    <circle cx="8" cy="14" r="1.25" fill="currentColor" />
    <circle cx="16" cy="14" r="1.25" fill="currentColor" />
    <circle cx="12" cy="8.5" r="1.35" fill="currentColor" />
  </svg>
);

/**
 * Expressive SSH Tunnel / Bastion route glyph: encrypted arch routing traffic
 * through a secured node between two endpoints.
 */
export const SshTunnelIcon: React.FC<RemoteDesktopIconProps> = ({
  size = 16,
  className,
  ...props
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
    {...props}
  >
    {/* Tunnel arch */}
    <path d="M4.5 16.5V12a7.5 7.5 0 0 1 15 0v4.5" opacity="0.45" />
    <path d="M7.5 16.5V12a4.5 4.5 0 0 1 9 0v4.5" />
    {/* Endpoint nodes */}
    <circle cx="4.5" cy="17.5" r="2" fill="currentColor" fillOpacity="0.16" />
    <circle cx="19.5" cy="17.5" r="2" fill="currentColor" fillOpacity="0.16" />
    {/* Encrypted lock badge at crest */}
    <rect
      x="9.5"
      y="12.5"
      width="5"
      height="4.25"
      rx="1"
      fill="currentColor"
      fillOpacity="0.22"
    />
    <path d="M10.75 12.5v-1a1.25 1.25 0 0 1 2.5 0v1" />
  </svg>
);

/**
 * System RDP Client icon: desktop screen with window panes and external launch arrow.
 */
export const SystemRdpClientIcon: React.FC<RemoteDesktopIconProps> = ({
  size = 16,
  className,
  ...props
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
    {...props}
  >
    <path d="M12.5 4H5a2.25 2.25 0 0 0-2.25 2.25v9.5A2.25 2.25 0 0 0 5 18h14a2.25 2.25 0 0 0 2.25-2.25V12" />
    <path d="M8.5 21h7" />
    <path d="M12 18v3" />
    {/* Four-pane window glyph inside left half */}
    <rect x="5.75" y="7.5" width="3" height="2.75" rx="0.5" fill="currentColor" fillOpacity="0.22" />
    <rect x="10.25" y="7.5" width="3" height="2.75" rx="0.5" fill="currentColor" fillOpacity="0.12" />
    <rect x="5.75" y="11.75" width="3" height="2.75" rx="0.5" fill="currentColor" fillOpacity="0.12" />
    <rect x="10.25" y="11.75" width="3" height="2.75" rx="0.5" fill="currentColor" fillOpacity="0.22" />
    {/* External launch arrow */}
    <path d="M16.25 3.75H20.5V8" />
    <path d="M15.25 9L20.5 3.75" />
  </svg>
);

/**
 * System VNC / macOS Screen Sharing icon: overlapping displays with external launch cue.
 */
export const SystemVncClientIcon: React.FC<RemoteDesktopIconProps> = ({
  size = 16,
  className,
  ...props
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
    {...props}
  >
    <rect
      x="3"
      y="8.25"
      width="13.5"
      height="10.25"
      rx="2"
      fill="currentColor"
      fillOpacity="0.14"
    />
    <path d="M7.25 21h5" />
    <path d="M9.75 18.5V21" />
    <path d="M7 8.25V6a2 2 0 0 1 2-2h3.5" opacity="0.65" />
    {/* External launch arrow */}
    <path d="M16.25 3.75H20.5V8" />
    <path d="M15.25 9L20.5 3.75" />
  </svg>
);

/**
 * Rich `.rdp` file badge icon for ImportVaultDialog: folded document sheet with
 * remote-desktop dual-arrow emblem and crisp `.RDP` file extension tag.
 */
export const RdpFileBadgeIcon: React.FC<RemoteDesktopIconProps> = ({
  size = 48,
  className,
  ...props
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 48 48"
    fill="none"
    className={className}
    aria-hidden="true"
    {...props}
  >
    {/* Document sheet */}
    <path
      d="M11 6.5A3.5 3.5 0 0 1 14.5 3h13.75L37 11.75V41.5A3.5 3.5 0 0 1 33.5 45h-19A3.5 3.5 0 0 1 11 41.5v-35Z"
      fill="#3B82F6"
      fillOpacity="0.12"
      stroke="#3B82F6"
      strokeWidth="2"
      strokeLinejoin="round"
    />
    {/* Folded corner */}
    <path
      d="M28 3.25V10a2 2 0 0 0 2 2h6.75"
      fill="#3B82F6"
      fillOpacity="0.2"
      stroke="#3B82F6"
      strokeWidth="2"
      strokeLinejoin="round"
    />
    {/* Mini dual-arrow monitor inside sheet */}
    <rect
      x="16.5"
      y="14.5"
      width="15"
      height="10.5"
      rx="2"
      fill="#3B82F6"
      fillOpacity="0.16"
      stroke="#2563EB"
      strokeWidth="1.75"
    />
    <path
      d="M20.5 18.25h7m-2-2L27.5 18.25L25.5 20.25"
      stroke="#2563EB"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M27.5 21.5h-7m2-2L20.5 21.5L22.5 23.5"
      stroke="#2563EB"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M21.5 27.5h5"
      stroke="#2563EB"
      strokeWidth="1.75"
      strokeLinecap="round"
    />
    {/* .RDP extension pill */}
    <rect x="7" y="30.5" width="34" height="11.5" rx="3.5" fill="#2563EB" />
    <text
      x="24"
      y="38.75"
      textAnchor="middle"
      fill="#FFFFFF"
      fontSize="8.5"
      fontWeight="700"
      fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
      letterSpacing="0.5"
    >
      .RDP
    </text>
  </svg>
);
