const { moshExtraResources } = require('./scripts/mosh-extra-resources.cjs');

/**
 * @type {import('electron-builder').Configuration}
 */
module.exports = {
    appId: 'com.netcatty.app',
    productName: 'Netcatty',
    artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
    // Platform-split icons (#813):
    //   - public/icon.png keeps Apple's HIG grid margin so the rendered
    //     squircle sits at ~88% of the PNG canvas. macOS needs this —
    //     the dock renders icons with its own rounding/shadow and most
    //     third-party apps (#803) leave that grid margin alone so the
    //     squircle lines up with neighbors.
    //   - public/icon-win.png uses a tight-crop viewBox so the squircle
    //     fills 100% of the PNG. Windows / Linux taskbars render icons
    //     full-bleed, so the Apple margin showed up as visible padding,
    //     making the app icon look smaller than other apps in taskbar /
    //     Start menu / desktop shortcuts.
    icon: 'public/icon.png',
    // npmRebuild must stay enabled for macOS and Windows builds — without it,
    // node-pty's native module is not recompiled for the Electron ABI, causing
    // "posix_spawnp failed" on macOS. Linux builds set npm_config_arch in CI
    // and run ensure-node-pty-linux.sh before packaging, so the rebuild is
    // redundant but harmless there.
    npmRebuild: true,
    directories: {
        buildResources: 'build',
        output: 'release'
    },
    files: [
        'dist/**/*',
        'electron/**/*',
        'lib/**/*.cjs',
        '!electron/.dev-config.json',
        'skills/**/*',
        'public/**/*',
        'node_modules/**/*'
    ],
    asarUnpack: [
        'node_modules/node-pty/**/*',
        'node_modules/ssh2/**/*',
        'node_modules/cpu-features/**/*',
        'node_modules/@vscode/windows-process-tree/**/*',
        'node_modules/@zed-industries/claude-agent-acp/**/*',
        'node_modules/@agentclientprotocol/sdk/**/*',
        'node_modules/@anthropic-ai/claude-agent-sdk/**/*',
        'node_modules/@zed-industries/codex-acp/**/*',
        'node_modules/@zed-industries/codex-acp-*/**/*',
        'node_modules/@modelcontextprotocol/sdk/**/*',
        'node_modules/zod/**/*',
        'node_modules/zod-to-json-schema/**/*',
        'node_modules/ajv/**/*',
        'node_modules/ajv-formats/**/*',
        'node_modules/fast-deep-equal/**/*',
        'node_modules/fast-uri/**/*',
        'node_modules/json-schema-traverse/**/*',
        'electron/cli/**/*',
        'electron/mcp/**/*'
        ,
        'skills/**/*'
    ],
    mac: {
        target: [
            {
                target: 'dmg',
                arch: ['arm64', 'x64']
            },
            {
                target: 'zip',
                arch: ['arm64', 'x64']
            }
        ],
        category: 'public.app-category.developer-tools',
        hardenedRuntime: true,
        notarize: true,
        entitlements: 'electron/entitlements.mac.plist',
        entitlementsInherit: 'electron/entitlements.mac.plist',
        extendInfo: {
            NSCameraUsageDescription: 'Netcatty may use the camera for video calls',
            NSMicrophoneUsageDescription: 'Netcatty may use the microphone for audio',
            NSLocalNetworkUsageDescription: 'Netcatty needs local network access for SSH connections'
        },
        extraResources: moshExtraResources('darwin')
    },
    dmg: {
        title: '${productName}',
        iconSize: 100,
        iconTextSize: 12,
        window: {
            width: 540,
            height: 380
        },
        contents: [
            { x: 140, y: 158 },
            { x: 400, y: 158, type: 'link', path: '/Applications' }
        ]
    },
    win: {
        icon: 'public/icon-win.png',
        target: [
            {
                target: 'nsis',
                arch: ['x64', 'arm64']
            },
            {
                target: 'portable',
                arch: ['x64', 'arm64']
            }
        ],
        extraResources: moshExtraResources('win32')
    },
    portable: {
        artifactName: '${productName}-${version}-portable-${os}-${arch}.${ext}',
    },
    nsis: {
        oneClick: false,
        perMachine: false,
        allowElevation: true,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        shortcutName: 'Netcatty'
    },
    linux: {
        // Linux desktop icons render full-bleed like Windows — use the
        // tight-crop source so the app icon doesn't look padded in KDE /
        // GNOME launchers or AppImage integrations.
        icon: 'public/icon-win.png',
        target: ['AppImage', 'deb', 'rpm'],
        category: 'Development',
        extraResources: moshExtraResources('linux')
    },
    deb: {
        // Use gzip instead of default xz(lzma) for better compatibility with
        // Deepin OS and other distros that have issues with lzma decompression
        compression: 'gz'
    },
    publish: [
        {
            provider: 'github',
            owner: 'binaricat',
            repo: 'Netcatty',
            releaseType: 'release'
        }
    ]
};
