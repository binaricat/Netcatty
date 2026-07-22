import React from "react";
import { DEFAULT_TERMINAL_WORD_SEPARATORS } from "../../../domain/models";
import type { DynamicTabTitleMode, LinkModifier, MiddleClickBehavior, RightClickBehavior, TerminalSettings } from "../../../domain/models";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { SectionHeader, Select, SettingRow, Toggle } from "../settings-ui";

type Translate = (key: string) => string;

interface TerminalBehaviorSettingsProps {
  t: Translate;
  terminalSettings: TerminalSettings;
  updateTerminalSetting: <K extends keyof TerminalSettings>(key: K, value: TerminalSettings[K]) => void;
}

export const MIDDLE_CLICK_BEHAVIOR_OPTIONS: Array<{
  value: MiddleClickBehavior;
  labelKey: string;
}> = [
  { value: "context-menu", labelKey: "settings.terminal.behavior.middleClick.menu" },
  { value: "paste", labelKey: "settings.terminal.behavior.middleClick.paste" },
  { value: "disabled", labelKey: "settings.terminal.behavior.middleClick.disabled" },
];

export const DYNAMIC_TAB_TITLE_MODE_OPTIONS: Array<{
  value: DynamicTabTitleMode;
  labelKey: string;
}> = [
  { value: "off", labelKey: "settings.terminal.behavior.dynamicTabTitle.off" },
  { value: "agent", labelKey: "settings.terminal.behavior.dynamicTabTitle.agent" },
  { value: "all", labelKey: "settings.terminal.behavior.dynamicTabTitle.all" },
];

export const TerminalBehaviorSettings: React.FC<TerminalBehaviorSettingsProps> = ({
  t,
  terminalSettings,
  updateTerminalSetting,
}) => (
  <>
      <SectionHeader title={t("settings.terminal.section.behavior")} />
      <div className="space-y-0 divide-y divide-border rounded-lg border bg-card px-4">
        <SettingRow
          label={t("settings.terminal.behavior.autoCloseOnExit")}
          description={t("settings.terminal.behavior.autoCloseOnExit.desc")}
        >
          <Toggle
            checked={terminalSettings.autoCloseOnExit}
            onChange={(v) => updateTerminalSetting("autoCloseOnExit", v)}
          />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.rightClick")}
          description={t("settings.terminal.behavior.rightClick.desc")}
        >
          <Select
            value={terminalSettings.rightClickBehavior}
            options={[
              { value: "context-menu", label: t("settings.terminal.behavior.rightClick.menu") },
              { value: "paste", label: t("settings.terminal.behavior.rightClick.paste") },
              { value: "select-word", label: t("settings.terminal.behavior.rightClick.selectWord") },
            ]}
            onChange={(v) => updateTerminalSetting("rightClickBehavior", v as RightClickBehavior)}
            className="w-36"
          />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.copyOnSelect")}
          description={t("settings.terminal.behavior.copyOnSelect.desc")}
        >
          <Toggle checked={terminalSettings.copyOnSelect} onChange={(v) => updateTerminalSetting("copyOnSelect", v)} />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.normalizeTextOnCopy")}
          description={t("settings.terminal.behavior.normalizeTextOnCopy.desc")}
        >
          <Toggle
            checked={terminalSettings.normalizeTextOnCopy ?? true}
            onChange={(v) => updateTerminalSetting("normalizeTextOnCopy", v)}
          />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.middleClick")}
          description={t("settings.terminal.behavior.middleClick.desc")}
        >
          <Select
            value={terminalSettings.middleClickBehavior}
            options={MIDDLE_CLICK_BEHAVIOR_OPTIONS.map((option) => ({
              value: option.value,
              label: t(option.labelKey),
            }))}
            onChange={(v) => updateTerminalSetting("middleClickBehavior", v as MiddleClickBehavior)}
            className="w-36"
          />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.wordSeparators")}
          description={t("settings.terminal.behavior.wordSeparators.desc")}
        >
          <Input
            value={terminalSettings.wordSeparators}
            onChange={(e) => updateTerminalSetting("wordSeparators", e.target.value)}
            placeholder={`${DEFAULT_TERMINAL_WORD_SEPARATORS}=,:`}
            className="w-56 font-mono"
            spellCheck={false}
          />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.bracketedPaste")}
          description={t("settings.terminal.behavior.bracketedPaste.desc")}
        >
          <Toggle checked={!terminalSettings.disableBracketedPaste} onChange={(v) => updateTerminalSetting("disableBracketedPaste", !v)} />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.shiftEnterNewline")}
          description={t("settings.terminal.behavior.shiftEnterNewline.desc")}
        >
          <Toggle checked={terminalSettings.shiftEnterNewlineEnabled ?? true} onChange={(v) => updateTerminalSetting("shiftEnterNewlineEnabled", v)} />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.shiftEnterNewlineText")}
          description={t("settings.terminal.behavior.shiftEnterNewlineText.desc")}
        >
          <Input
            value={terminalSettings.shiftEnterNewlineText ?? "\\n"}
            onChange={(e) => updateTerminalSetting("shiftEnterNewlineText", e.target.value)}
            placeholder="\\n"
            className="w-56 font-mono"
            spellCheck={false}
          />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.clearWipesScrollback")}
          description={t("settings.terminal.behavior.clearWipesScrollback.desc")}
        >
          <Toggle checked={terminalSettings.clearWipesScrollback ?? true} onChange={(v) => updateTerminalSetting("clearWipesScrollback", v)} />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.preserveSelectionOnInput")}
          description={t("settings.terminal.behavior.preserveSelectionOnInput.desc")}
        >
          <Toggle checked={terminalSettings.preserveSelectionOnInput ?? false} onChange={(v) => updateTerminalSetting("preserveSelectionOnInput", v)} />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.forcePromptNewLine")}
          description={t("settings.terminal.behavior.forcePromptNewLine.desc")}
        >
          <Toggle checked={terminalSettings.forcePromptNewLine ?? false} onChange={(v) => updateTerminalSetting("forcePromptNewLine", v)} />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.dynamicTabTitle")}
          description={t("settings.terminal.behavior.dynamicTabTitle.desc")}
        >
          <Select
            value={terminalSettings.dynamicTabTitleMode ?? "agent"}
            options={DYNAMIC_TAB_TITLE_MODE_OPTIONS.map((option) => ({
              value: option.value,
              label: t(option.labelKey),
            }))}
            onChange={(v) => updateTerminalSetting("dynamicTabTitleMode", v as DynamicTabTitleMode)}
            className="w-44"
          />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.osc52Clipboard")}
          description={t("settings.terminal.behavior.osc52Clipboard.desc")}
        >
          <Select
            value={terminalSettings.osc52Clipboard ?? 'write-only'}
            options={[
              { value: "off", label: t("settings.terminal.behavior.osc52Clipboard.off") },
              { value: "write-only", label: t("settings.terminal.behavior.osc52Clipboard.writeOnly") },
              { value: "read-write", label: t("settings.terminal.behavior.osc52Clipboard.readWrite") },
              { value: "prompt", label: t("settings.terminal.behavior.osc52Clipboard.prompt") },
            ]}
            onChange={(v) => updateTerminalSetting("osc52Clipboard", v as "off" | "write-only" | "read-write" | "prompt")}
            className="w-40"
          />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.scrollOnInput")}
          description={t("settings.terminal.behavior.scrollOnInput.desc")}
        >
          <Toggle checked={terminalSettings.scrollOnInput} onChange={(v) => updateTerminalSetting("scrollOnInput", v)} />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.scrollOnOutput")}
          description={t("settings.terminal.behavior.scrollOnOutput.desc")}
        >
          <Toggle checked={terminalSettings.scrollOnOutput} onChange={(v) => updateTerminalSetting("scrollOnOutput", v)} />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.scrollOnKeyPress")}
          description={t("settings.terminal.behavior.scrollOnKeyPress.desc")}
        >
          <Toggle checked={terminalSettings.scrollOnKeyPress} onChange={(v) => updateTerminalSetting("scrollOnKeyPress", v)} />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.scrollOnPaste")}
          description={t("settings.terminal.behavior.scrollOnPaste.desc")}
        >
          <Toggle checked={terminalSettings.scrollOnPaste} onChange={(v) => updateTerminalSetting("scrollOnPaste", v)} />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.smoothScrolling")}
          description={t("settings.terminal.behavior.smoothScrolling.desc")}
        >
          <Toggle checked={terminalSettings.smoothScrolling} onChange={(v) => updateTerminalSetting("smoothScrolling", v)} />
        </SettingRow>

        <SettingRow
          label={t("settings.terminal.behavior.linkModifier")}
          description={t("settings.terminal.behavior.linkModifier.desc")}
        >
          <Select
            value={terminalSettings.linkModifier}
            options={[
              { value: "none", label: t("settings.terminal.behavior.linkModifier.none") },
              { value: "ctrl", label: t("settings.terminal.behavior.linkModifier.ctrl") },
              { value: "alt", label: t("settings.terminal.behavior.linkModifier.alt") },
              { value: "meta", label: t("settings.terminal.behavior.linkModifier.meta") },
            ]}
            onChange={(v) => updateTerminalSetting("linkModifier", v as LinkModifier)}
            className="w-48"
          />
        </SettingRow>
      </div>

      <SectionHeader title={t("settings.terminal.section.scrollback")} />
      <div className="rounded-lg border bg-card p-4">
        <p className="text-sm text-muted-foreground mb-3">
          {t("settings.terminal.scrollback.desc")}
        </p>
        <div className="space-y-1">
          <Label className="text-xs">{t("settings.terminal.scrollback.rows")}</Label>
          <Input
            type="number"
            min={0}
            max={100000}
            value={terminalSettings.scrollback}
            onChange={(e) => {
              const val = parseInt(e.target.value);
              if (!isNaN(val) && val >= 0 && val <= 100000) {
                updateTerminalSetting("scrollback", val);
              }
            }}
            className="w-full"
          />
        </div>
      </div>

      <SectionHeader title={t("settings.terminal.section.startupCommand")} />
      <div className="rounded-lg border bg-card p-4">
        <p className="text-sm text-muted-foreground mb-3">
          {t("settings.terminal.startupCommandDelay.desc")}
        </p>
        <div className="space-y-1">
          <Label className="text-xs">{t("settings.terminal.startupCommandDelay.label")}</Label>
          <Input
            type="number"
            min={0}
            max={10000}
            value={terminalSettings.startupCommandDelayMs}
            onChange={(e) => {
              const val = parseInt(e.target.value);
              if (!isNaN(val) && val >= 0 && val <= 10000) {
                updateTerminalSetting("startupCommandDelayMs", val);
              }
            }}
            className="w-full"
          />
        </div>
      </div>
  </>
);
