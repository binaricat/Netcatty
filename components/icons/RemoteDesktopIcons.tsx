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

/**
 * Netcatty Catty agent silhouette glyph (matching `public/ai/agents/catty.svg`).
 */
export const CattyIcon: React.FC<RemoteDesktopIconProps> = ({
  size = 16,
  className,
  ...props
}) => (
  <svg
    width={size}
    height={size}
    viewBox="150 25 680 950"
    fill="currentColor"
    className={className}
    aria-hidden="true"
    {...props}
  >
    <path d="M467.1488 555.52a48.0768 48.0768 0 1 0-48.0256-48.0256 48.0256 48.0256 0 0 0 48.0256 48.0256zM602.0608 463.5136c-23.4496 26.9312-46.7968 68.6592 6.0928 64.512s59.2896-25.6 57.0368-71.168-38.5024-21.6576-63.1296 6.656zM615.1168 383.3344a45.5168 45.5168 0 1 0-45.4656-45.4144 45.5168 45.5168 0 0 0 45.4656 45.4144z" />
    <path d="M780.3904 554.5984c6.5024-9.2672 13.056-18.9952 19.6096-29.2864 56.8832-88.8832 48.896-160.4608 32.1536-204.8-21.9648-58.112-73.5232-106.3424-136.2944-128-47.8208-75.8272-182.4768-165.376-238.1824-142.6944-61.44 24.9856-65.8432 141.056-64.9728 190.0032a322.56 322.56 0 0 0-58.5728 66.56c-15.36 3.6864-41.984 10.752-69.5808 20.1216-67.7376 23.04-99.072 45.4656-104.7552 75.0592-11.8272 60.928 68.7104 158.72 173.7728 212.48 6.7072 10.5984 13.4656 20.48 20.48 29.0304-21.9136 21.1456-83.9168 92.16-55.552 194.304 21.3504 76.8 83.968 123.4944 168.0384 125.3376l7.424 8.448c2.304 2.6112 4.3008 5.12 5.7856 6.656a45.4656 45.4656 0 0 0 34.9184 16.3328h42.1888a45.568 45.568 0 0 0 45.5168-45.5168v-0.768h17.7152a45.6192 45.6192 0 0 0 45.5168 44.5952h42.7008a46.7968 46.7968 0 0 0 27.4944-9.728l1.024-0.7168c58.0096-39.424 93.2864-95.6928 102.0416-162.816 9.472-72.7552-14.3872-148.48-43.8272-190.464 3.0208-35.584-1.4336-58.7776-14.6432-74.1376zM220.16 415.2832c12.6464-14.08 76.3392-37.8368 139.6736-51.7632a30.72 30.72 0 0 0 19.6096-14.0288c8.0384-13.2608 34.7136-51.2 61.44-68.6592a30.72 30.72 0 0 0 13.9264-27.392c-5.12-89.3952 15.36-138.8032 25.1392-145.92 26.8288 0 135.8848 62.976 168.1408 124.7744a30.72 30.72 0 0 0 18.7392 15.36c39.1168 11.264 88.0128 42.0352 107.8784 94.72 16.896 44.7488 7.7312 96.6656-26.4192 150.0672-92.16 144.3328-174.848 169.9328-206.0288 174.08-34.048 4.7616-97.28 13.4656-160.768-91.904a30.72 30.72 0 0 0-12.8512-11.8784c-99.9936-48.4352-148.1216-126.1056-148.48-147.456z m137.5744 405.6576c-19.7632-71.2704 25.6-120.9856 38.9632-133.6832 1.792 1.4848 3.584 2.9184 5.12 4.2496-28.928 80.6912-11.2128 149.1968 14.9504 199.68-29.3888-12.6464-49.8688-36.5056-59.2384-70.2464z m420.2496-9.728c-6.5024 49.8688-31.8464 90.1632-75.4176 119.7568h-20.992a45.5168 45.5168 0 0 0-45.3632-44.5952h-49.8688a45.4656 45.4656 0 0 0-45.3632 45.4144v0.8704h-18.9952a39.424 39.424 0 0 0-1.9968-2.2528c-44.3904-50.176-91.0848-118.9376-63.0784-209.3056a177.9712 177.9712 0 0 0 57.1904 9.216 260.7616 260.7616 0 0 0 36.7616-2.9696c38.5024-5.12 106.8032-28.1088 183.6544-114.3808 0 5.4784-0.6656 12.288-1.7408 20.8384a30.72 30.72 0 0 0 7.2704 24.064c20.1216 23.3472 46.1824 88.2176 37.7344 153.344z" />
  </svg>
);
