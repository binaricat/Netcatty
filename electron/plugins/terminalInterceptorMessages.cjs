"use strict";

const { escapePermissionText } = require("./nativePermissionDecision.cjs");

const MESSAGES = Object.freeze({
  en: Object.freeze({
    noInterceptor: "No interceptor",
    selectTitle: (direction) => `Terminal ${direction} interceptor`,
    selectMessage: (direction) => `Multiple plugins can intercept Terminal ${direction} data. Choose one for this session.`,
    warningTitle: "Terminal interceptor disabled",
    warningMessage: "A Terminal interceptor was disabled for this session.",
    warningDetail: "The plugin failed or exceeded its data-path budget.",
  }),
  "zh-CN": Object.freeze({
    noInterceptor: "不使用拦截器",
    selectTitle: (direction) => `终端${direction === "input" ? "输入" : "输出"}拦截器`,
    selectMessage: (direction) => `多个插件可以拦截终端${direction === "input" ? "输入" : "输出"}数据。请选择本会话使用的插件。`,
    warningTitle: "终端拦截器已停用",
    warningMessage: "本会话的一个终端拦截器已被停用。",
    warningDetail: "插件失败或超过了数据通道预算。",
  }),
  "zh-TW": Object.freeze({
    noInterceptor: "不使用攔截器",
    selectTitle: (direction) => `終端${direction === "input" ? "輸入" : "輸出"}攔截器`,
    selectMessage: (direction) => `多個外掛程式可以攔截終端${direction === "input" ? "輸入" : "輸出"}資料。請選擇本工作階段使用的外掛程式。`,
    warningTitle: "終端攔截器已停用",
    warningMessage: "本工作階段的一個終端攔截器已被停用。",
    warningDetail: "外掛程式失敗或超過資料通道預算。",
  }),
  ru: Object.freeze({
    noInterceptor: "Без перехватчика",
    selectTitle: (direction) => `Перехватчик ${direction === "input" ? "ввода" : "вывода"} терминала`,
    selectMessage: (direction) => `Несколько плагинов могут перехватывать ${direction === "input" ? "ввод" : "вывод"} терминала. Выберите один для этого сеанса.`,
    warningTitle: "Перехватчик терминала отключён",
    warningMessage: "Перехватчик терминала был отключён для этого сеанса.",
    warningDetail: "Плагин завершился с ошибкой или превысил бюджет канала данных.",
  }),
});

function terminalInterceptorMessages(locale) {
  return MESSAGES[locale] ?? MESSAGES[String(locale).split("-")[0]] ?? MESSAGES.en;
}

function terminalInterceptorChoiceLabel(entry) {
  const plugin = escapePermissionText(
    entry?.pluginDisplayName ?? entry?.pluginId ?? "Plugin",
    160,
  );
  const provider = escapePermissionText(entry?.provider?.label ?? entry?.provider?.id ?? "Provider", 160);
  const pluginId = escapePermissionText(entry?.pluginId ?? "unknown-plugin", 128);
  const providerId = escapePermissionText(entry?.provider?.id ?? "unknown-provider", 192);
  return `${plugin} (${pluginId}): ${provider} (${providerId})`;
}

function terminalInterceptorIdentifier(value) {
  return escapePermissionText(value ?? "", 256);
}

module.exports = {
  terminalInterceptorChoiceLabel,
  terminalInterceptorIdentifier,
  terminalInterceptorMessages,
};
