export const STORAGE_KEY_HOSTS = 'netcatty_hosts_v1';
export const STORAGE_KEY_KEYS = 'netcatty_keys_v1';
export const STORAGE_KEY_GROUPS = 'netcatty_groups_v1';
export const STORAGE_KEY_CUSTOM_GROUPS = STORAGE_KEY_GROUPS;
export const STORAGE_KEY_SNIPPETS = 'netcatty_snippets_v1';
export const STORAGE_KEY_SNIPPET_PACKAGES = 'netcatty_snippet_packages_v1';
export const STORAGE_KEY_NOTES = 'netcatty_notes_v1';
export const STORAGE_KEY_NOTE_GROUPS = 'netcatty_note_groups_v1';
/** Last-filled values per snippet id for {{variable}} placeholders. */
export const STORAGE_KEY_SNIPPET_VAR_VALUES = 'netcatty_snippet_var_values_v1';
export const STORAGE_KEY_THEME = 'netcatty_theme_v1';
export const STORAGE_KEY_COLOR = 'netcatty_color_v1';
export const STORAGE_KEY_ACCENT_MODE = 'netcatty_accent_mode_v1';
export const STORAGE_KEY_UI_THEME_LIGHT = 'netcatty_ui_theme_light_v1';
export const STORAGE_KEY_UI_THEME_DARK = 'netcatty_ui_theme_dark_v1';
export const STORAGE_KEY_UI_FONT_FAMILY = 'netcatty_ui_font_family_v1';
export const STORAGE_KEY_SYNC = 'netcatty_sync_v1';
/** Device-local experimental convergent-sync toggle; never included in SyncPayload settings. */
export const STORAGE_KEY_CONVERGENT_SYNC_CONFIG = 'netcatty_convergent_sync_config_v2';
export const STORAGE_KEY_TERM_THEME = 'netcatty_term_theme_v1';
export const STORAGE_KEY_TERM_FOLLOW_APP_THEME = 'netcatty_term_follow_app_theme_v1';
export const STORAGE_KEY_TERM_THEME_DARK = 'netcatty_term_theme_dark_v1';
export const STORAGE_KEY_TERM_THEME_LIGHT = 'netcatty_term_theme_light_v1';
export const STORAGE_KEY_TERM_FONT_FAMILY = 'netcatty_term_font_family_v1';
export const STORAGE_KEY_TERM_FONT_SIZE = 'netcatty_term_font_size_v1';
export const STORAGE_KEY_TERM_SETTINGS = 'netcatty_term_settings_v1';
export const STORAGE_KEY_HOTKEY_SCHEME = 'netcatty_hotkey_scheme_v1';
export const STORAGE_KEY_CUSTOM_KEY_BINDINGS = 'netcatty_custom_key_bindings_v1';
export const STORAGE_KEY_HOTKEY_RECORDING = 'netcatty_hotkey_recording_v1';
export const STORAGE_KEY_CUSTOM_CSS = 'netcatty_custom_css_v1';
export const STORAGE_KEY_UI_LANGUAGE = 'netcatty_ui_language_v1';
export const STORAGE_KEY_PORT_FORWARDING = 'netcatty_port_forwarding_v1';
export const STORAGE_KEY_PF_PREFER_FORM_MODE = 'netcatty_pf_prefer_form_mode_v1';
export const STORAGE_KEY_PF_VIEW_MODE = 'netcatty_pf_view_mode_v1';
export const STORAGE_KEY_KNOWN_HOSTS = 'netcatty_known_hosts_v1';
export const STORAGE_KEY_SHELL_HISTORY = 'netcatty_shell_history_v1';
export const STORAGE_KEY_CONNECTION_LOGS = 'netcatty_connection_logs_v1';
/** Side store for unsaved connection-log terminal replay buffers (main blob omits them for perf). */
export const STORAGE_KEY_CONNECTION_LOG_TERMINAL_DATA = 'netcatty_connection_log_terminal_data_v1';
export const STORAGE_KEY_SESSION_RESTORE = 'netcatty_session_restore_v1';
export const STORAGE_KEY_RESTORE_PREVIOUS_SESSION = 'netcatty_restore_previous_session_v1';
export const STORAGE_KEY_RESTORE_TERMINAL_CWD = 'netcatty_restore_terminal_cwd_v1';
export const STORAGE_KEY_IDENTITIES = 'netcatty_identities_v1';
export const STORAGE_KEY_PROXY_PROFILES = 'netcatty_proxy_profiles_v1';
export const STORAGE_KEY_VAULT_HOSTS_VIEW_MODE = 'netcatty_vault_hosts_view_mode_v1';
export const STORAGE_KEY_VAULT_HOSTS_SORT_MODE = 'netcatty_vault_hosts_sort_mode_v1';
export const STORAGE_KEY_VAULT_HOSTS_TREE_EXPANDED = 'netcatty_vault_hosts_tree_expanded_v1';
export const STORAGE_KEY_VAULT_SIDEBAR_COLLAPSED = 'netcatty_vault_sidebar_collapsed_v1';
export const STORAGE_KEY_VAULT_SIDEBAR_WIDTH = 'netcatty_vault_sidebar_width_v1';
export const STORAGE_KEY_VAULT_KEYS_VIEW_MODE = 'netcatty_vault_keys_view_mode_v1';
export const STORAGE_KEY_VAULT_PROXY_PROFILES_VIEW_MODE = 'netcatty_vault_proxy_profiles_view_mode_v1';
export const STORAGE_KEY_VAULT_SNIPPETS_VIEW_MODE = 'netcatty_vault_snippets_view_mode_v1';
export const STORAGE_KEY_VAULT_NOTES_VIEW_MODE = 'netcatty_vault_notes_view_mode_v1';
export const STORAGE_KEY_VAULT_NOTES_EDITOR_MODE = 'netcatty_vault_notes_editor_mode_v1';
export const STORAGE_KEY_VAULT_NOTES_SELECTED_GROUP = 'netcatty_vault_notes_selected_group_v1';
export const STORAGE_KEY_VAULT_NOTES_TREE_WIDTH = 'netcatty_vault_notes_tree_width_v1';
/** Inline snippet/script edit panel width (px). */
export const STORAGE_KEY_SNIPPETS_PANEL_WIDTH = 'netcatty_snippets_panel_width_v1';
/** Inline vault host/group details panel width (px). */
export const STORAGE_KEY_VAULT_HOST_PANEL_WIDTH = 'netcatty_vault_host_panel_width_v1';
/** Inline snippet script editor height (px) in vault edit panel. */
export const STORAGE_KEY_SNIPPET_SCRIPT_EDITOR_HEIGHT = 'netcatty_snippet_script_editor_height_v1';
/** Automation script Monaco editor height (px) in vault sidebar. */
export const STORAGE_KEY_SCRIPT_EDITOR_HEIGHT = 'netcatty_script_editor_height_v1';
/** Terminal compose bar total height (px). */
export const STORAGE_KEY_COMPOSE_BAR_HEIGHT = 'netcatty_compose_bar_height_v1';
/** Snippet IDs pinned to the terminal compose bar quick strip. */
export const STORAGE_KEY_COMPOSE_BAR_PINNED_SNIPPETS = 'netcatty_compose_bar_pinned_snippets_v1';
export const STORAGE_KEY_VAULT_KNOWN_HOSTS_VIEW_MODE = 'netcatty_vault_known_hosts_view_mode_v1';

// Update check
export const STORAGE_KEY_UPDATE_LAST_CHECK = 'netcatty_update_last_check_v1';
export const STORAGE_KEY_UPDATE_DISMISSED_VERSION = 'netcatty_update_dismissed_version_v1';
export const STORAGE_KEY_UPDATE_LATEST_RELEASE = 'netcatty_update_latest_release_v1';
export const STORAGE_KEY_AUTO_UPDATE_ENABLED = 'netcatty_auto_update_enabled_v1';
export const STORAGE_KEY_LOCAL_VAULT_BACKUP_MAX_COUNT = 'netcatty_local_vault_backup_max_count_v1';
export const STORAGE_KEY_LOCAL_VAULT_BACKUP_LAST_APP_VERSION = 'netcatty_local_vault_backup_last_app_version_v1';

/**
 * Cross-window barrier: set while a local vault restore is applying so
 * auto-sync in another window doesn't upload a pre-restore snapshot
 * concurrently. The value is an epoch-ms deadline — auto-sync treats any
 * value in the future as "restore in progress" and any value in the past
 * as a stale lock that can be ignored. See useAutoSync and
 * CloudSyncSettings for readers/writers.
 */
export const STORAGE_KEY_VAULT_RESTORE_IN_PROGRESS_UNTIL = 'netcatty_vault_restore_in_progress_until_v1';

/**
 * Apply-in-progress sentinel. Set before a destructive applySyncPayload
 * starts writing and cleared after it completes successfully. If this
 * value is present on a later startup, the previous apply was
 * interrupted mid-way (renderer crash, power loss, IPC failure) and the
 * local vault is a partial mix of pre-apply and post-apply state.
 * Auto-sync must refuse to push in that window — otherwise the partial
 * state would silently overwrite an intact cloud copy — until the user
 * manually restores from a protective backup or completes a full merge.
 * The value is a JSON-encoded record (startedAt, protectiveBackupId,
 * source) so the UI can surface a specific recovery hint rather than a
 * generic "something broke" warning.
 */
export const STORAGE_KEY_VAULT_APPLY_IN_PROGRESS = 'netcatty_vault_apply_in_progress_v1';

// SFTP File Opener Associations
export const STORAGE_KEY_SFTP_FILE_ASSOCIATIONS = 'netcatty_sftp_file_associations_v1';
export const STORAGE_KEY_SFTP_DEFAULT_OPENER = 'netcatty_sftp_default_opener_v1';

// SFTP Local Bookmarks
export const STORAGE_KEY_SFTP_LOCAL_BOOKMARKS = 'netcatty_sftp_local_bookmarks_v1';

// SFTP Global Bookmarks (shared across all hosts)
export const STORAGE_KEY_SFTP_GLOBAL_BOOKMARKS = 'netcatty_sftp_global_bookmarks_v1';

// SFTP Settings
export const STORAGE_KEY_SFTP_DOUBLE_CLICK_BEHAVIOR = 'netcatty_sftp_double_click_behavior_v1';
export const STORAGE_KEY_SFTP_AUTO_SYNC = 'netcatty_sftp_auto_sync_v1';
export const STORAGE_KEY_SFTP_SHOW_HIDDEN_FILES = 'netcatty_sftp_show_hidden_files_v1';
export const STORAGE_KEY_SFTP_USE_COMPRESSED_UPLOAD = 'netcatty_sftp_use_compressed_upload_v1';
export const STORAGE_KEY_SFTP_AUTO_OPEN_SIDEBAR = 'netcatty_sftp_auto_open_sidebar_v1';
export const STORAGE_KEY_SFTP_FOLLOW_TERMINAL_CWD = 'netcatty_sftp_follow_terminal_cwd_v1';
export const STORAGE_KEY_SFTP_DEFAULT_VIEW_MODE = 'netcatty_sftp_default_view_mode_v1';
export const STORAGE_KEY_SFTP_HOST_VIEW_MODES = 'netcatty_sftp_host_view_modes_v1';
export const STORAGE_KEY_SFTP_VISIBLE_COLUMNS = 'netcatty_sftp_visible_columns_v1';
export const STORAGE_KEY_SFTP_DIRECTORIES_FIRST = 'netcatty_sftp_directories_first_v1';
/** Dense SFTP toolbar actions: show / collapse / hide + order. */
export const STORAGE_KEY_SFTP_TOOLBAR_LAYOUT = 'netcatty_sftp_toolbar_layout_v1';
/** Dense terminal session toolbar actions: show / collapse / hide + order. */
export const STORAGE_KEY_TERMINAL_TOOLBAR_LAYOUT = 'netcatty_terminal_toolbar_layout_v1';
/** Side-panel tab strip: show / collapse / hide + order (supersedes order-only key when present). */
export const STORAGE_KEY_TERMINAL_SIDE_PANEL_TAB_LAYOUT = 'netcatty_terminal_side_panel_tab_layout_v1';
export const STORAGE_KEY_SFTP_TRANSFER_PANEL_HEIGHT = 'netcatty_sftp_transfer_panel_height_v1';
export const STORAGE_KEY_SFTP_TRANSFER_CHILD_NAME_WIDTH = 'netcatty_sftp_transfer_child_name_width_v1';

// Editor Settings
export const STORAGE_KEY_EDITOR_WORD_WRAP = 'netcatty_editor_word_wrap_v1';

// Session Logs Settings
export const STORAGE_KEY_SESSION_LOGS_ENABLED = 'netcatty_session_logs_enabled_v1';
export const STORAGE_KEY_SESSION_LOGS_DIR = 'netcatty_session_logs_dir_v1';
export const STORAGE_KEY_SESSION_LOGS_FORMAT = 'netcatty_session_logs_format_v1';
export const STORAGE_KEY_SESSION_LOGS_TIMESTAMPS_ENABLED = 'netcatty_session_logs_timestamps_enabled_v1';
export const STORAGE_KEY_SSH_DEBUG_LOGS_ENABLED = 'netcatty_ssh_debug_logs_enabled_v1';
export const STORAGE_KEY_SSH_DEEP_LINK_ENABLED = 'netcatty_ssh_deep_link_enabled_v1';
export const STORAGE_KEY_JMS_DEEP_LINK_ENABLED = 'netcatty_jms_deep_link_enabled_v1';

// Archived legacy key records that are no longer supported by the app (e.g. biometric/WebAuthn/FIDO2 experiments).
export const STORAGE_KEY_LEGACY_KEYS = 'netcatty_legacy_keys_v1';

// Managed Sources - external files that manage groups of hosts (e.g., ~/.ssh/config)
export const STORAGE_KEY_MANAGED_SOURCES = 'netcatty_managed_sources_v1';

// Global Toggle Window Settings (Quake Mode)
export const STORAGE_KEY_TOGGLE_WINDOW_HOTKEY = 'netcatty_toggle_window_hotkey_v1';
export const STORAGE_KEY_CLOSE_TO_TRAY = 'netcatty_close_to_tray_v1';
/** App-level HTTP(S) proxy for cloud sync / AI (not SSH ProxyJump). */
export const STORAGE_KEY_HTTP_NETWORK_PROXY = 'netcatty_http_network_proxy_v1';
export const STORAGE_KEY_GLOBAL_HOTKEY_ENABLED = 'netcatty_global_hotkey_enabled_v1';
export const STORAGE_KEY_WINDOW_OPACITY = 'netcatty_window_opacity_v1';
export const STORAGE_KEY_APP_ICON_VARIANT = 'netcatty_app_icon_variant_v1';
// Custom Terminal Themes
export const STORAGE_KEY_CUSTOM_THEMES = 'netcatty_custom_themes_v1';

// AI Settings
export const STORAGE_KEY_AI_PROVIDERS = 'netcatty_ai_providers_v1';
export const STORAGE_KEY_AI_ACTIVE_PROVIDER = 'netcatty_ai_active_provider_v1';
export const STORAGE_KEY_AI_ACTIVE_MODEL = 'netcatty_ai_active_model_v1';
export const STORAGE_KEY_AI_PERMISSION_MODE = 'netcatty_ai_permission_mode_v1';
export const STORAGE_KEY_AI_TOOL_INTEGRATION_MODE = 'netcatty_ai_tool_integration_mode_v1';
export const STORAGE_KEY_AI_HOST_PERMISSIONS = 'netcatty_ai_host_permissions_v1';
export const STORAGE_KEY_AI_EXTERNAL_AGENTS = 'netcatty_ai_external_agents_v1';
export const STORAGE_KEY_AI_DEFAULT_AGENT = 'netcatty_ai_default_agent_v1';
export const STORAGE_KEY_AI_COMMAND_BLOCKLIST = 'netcatty_ai_command_blocklist_v1';
export const STORAGE_KEY_AI_COMMAND_TIMEOUT = 'netcatty_ai_command_timeout_v1';
export const STORAGE_KEY_AI_MAX_ITERATIONS = 'netcatty_ai_max_iterations_v1';
export const STORAGE_KEY_AI_SESSIONS = 'netcatty_ai_sessions_v1';
export const STORAGE_KEY_AI_ACTIVE_SESSION_MAP = 'netcatty_ai_active_session_map_v1';
export const STORAGE_KEY_AI_AGENT_MODEL_MAP = 'netcatty_ai_agent_model_map_v1';
export const STORAGE_KEY_AI_AGENT_PROVIDER_MAP = 'netcatty_ai_agent_provider_map_v1';
export const STORAGE_KEY_AI_WEB_SEARCH = 'netcatty_ai_web_search_v1';
export const STORAGE_KEY_AI_QUICK_MESSAGES = 'netcatty_ai_quick_messages_v1';
/** Confirm-mode permission grant memory (capability + session/command patterns). */
export const STORAGE_KEY_AI_PERMISSION_GRANTS = 'netcatty_ai_permission_grants_v1';
export const STORAGE_KEY_AI_SHOW_TERMINAL_SELECTION_ACTION = 'netcatty_ai_show_terminal_selection_action_v1';
/** External MCP: whether the user last enabled the public catalog MCP endpoint. */
export const STORAGE_KEY_AI_EXTERNAL_MCP_ENABLED = 'netcatty_ai_external_mcp_enabled_v1';
/** External MCP lifecycle mode: temporary (idle timeout) or persistent (restore on launch). */
export const STORAGE_KEY_AI_EXTERNAL_MCP_MODE = 'netcatty_ai_external_mcp_mode_v1';
/** External MCP idle timeout in minutes (temporary mode only). */
export const STORAGE_KEY_AI_EXTERNAL_MCP_IDLE_TIMEOUT_MINUTES = 'netcatty_ai_external_mcp_idle_timeout_minutes_v1';
/** External MCP: whether host_open should surface/focus the main window (default true). */
export const STORAGE_KEY_AI_EXTERNAL_MCP_FOCUS_ON_HOST_OPEN = 'netcatty_ai_external_mcp_focus_on_host_open_v1';
/** Idle timeout for terminal sessions opened by an AI through host_open. */
export const STORAGE_KEY_AI_SESSION_IDLE_TIMEOUT_MINUTES = 'netcatty_ai_session_idle_timeout_minutes_v1';

// SFTP Transfer Concurrency
export const STORAGE_KEY_SFTP_TRANSFER_CONCURRENCY = 'netcatty_sftp_transfer_concurrency_v1';

// Workspace Focus Indicator Style
export const STORAGE_KEY_WORKSPACE_FOCUS_STYLE = 'netcatty_workspace_focus_style_v1';

// Vault: Show Recently Connected hosts section
export const STORAGE_KEY_SHOW_RECENT_HOSTS = 'netcatty_show_recent_hosts_v1';
export const STORAGE_KEY_HOST_CLICK_BEHAVIOR = 'netcatty_host_click_behavior_v1';
export const STORAGE_KEY_SHOW_ONLY_UNGROUPED_HOSTS_IN_ROOT = 'netcatty_show_only_ungrouped_hosts_in_root_v1';

// Top tabs: Show standalone SFTP view tab
export const STORAGE_KEY_SHOW_SFTP_TAB = 'netcatty_show_sftp_tab_v1';
export const STORAGE_KEY_SHOW_HOST_TREE_SIDEBAR = 'netcatty_show_host_tree_sidebar_v1';

// Shortcuts: Cmd/Ctrl+[1...9] and Ctrl+Tab skip pinned Vault/SFTP tabs
export const STORAGE_KEY_SHELL_ONLY_TAB_NUMBER_SHORTCUTS = 'netcatty_shell_only_tab_number_shortcuts_v1';

// Shortcuts: disable terminal font zoom shortcuts
export const STORAGE_KEY_DISABLE_TERMINAL_FONT_ZOOM = 'netcatty_disable_terminal_font_zoom_v1';

// Group Configurations (default settings inherited by hosts)
export const STORAGE_KEY_GROUP_CONFIGS = 'netcatty_group_configs_v1';

// Side Panel
export const STORAGE_KEY_SIDE_PANEL_WIDTH = 'netcatty_side_panel_width';
export const STORAGE_KEY_TERMINAL_SIDE_PANEL_TAB_ORDER = 'netcatty_terminal_side_panel_tab_order_v1';
export const STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN = 'netcatty_terminal_side_panel_auto_open_v1';
export const STORAGE_KEY_TERMINAL_SIDE_PANEL_AUTO_OPEN_TAB = 'netcatty_terminal_side_panel_auto_open_tab_v1';
export const STORAGE_KEY_WORKSPACE_FOCUS_SIDEBAR_WIDTH = 'netcatty_workspace_focus_sidebar_width';
export const STORAGE_KEY_TERMINAL_HOST_TREE_WIDTH = 'netcatty_terminal_host_tree_width_v1';
export const STORAGE_KEY_TERMINAL_HOST_TREE_COLLAPSED = 'netcatty_terminal_host_tree_collapsed_v1';
export const STORAGE_KEY_TERMINAL_COMPOSE_BAR_OPEN = 'netcatty_terminal_compose_bar_open_v1';
export const STORAGE_KEY_TERMINAL_SEARCH_OPEN = 'netcatty_terminal_search_open_v1';
export const STORAGE_KEY_TERMINAL_ENCODING_BY_HOST_PREFIX = 'netcatty_terminal_encoding_by_host_v1:';
export const STORAGE_KEY_TERMINAL_YMODEM_SEND_DIR = 'netcatty_terminal_ymodem_send_dir_v1';

// Port Forwarding (transient cross-window broadcast key)
export const STORAGE_KEY_PF_RECONNECT_CANCEL = '__netcatty_pf_cancel_reconnect';

// Default SSH Key Passphrases (for ~/.ssh keys not managed in the vault)
export const STORAGE_KEY_DEFAULT_KEY_PASSPHRASES = 'netcatty_default_key_passphrases_v1';

// Debug Flags (no _v1 suffix — developer-only, not persisted data)
export const STORAGE_KEY_DEBUG_HOTKEYS = 'debug.hotkeys';
export const STORAGE_KEY_DEBUG_UPDATE_DEMO = 'debug.updateDemo';
