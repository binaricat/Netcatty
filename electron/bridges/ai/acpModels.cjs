function toNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeConfigOptionValue(value) {
  const id = toNonEmptyString(value?.value ?? value?.id);
  if (!id) return null;
  return {
    id,
    name: toNonEmptyString(value?.name ?? value?.displayName) || id,
    description: toNonEmptyString(value?.description) || undefined,
  };
}

function flattenConfigOptionValues(values) {
  if (!Array.isArray(values)) return [];
  const flattened = [];
  for (const value of values) {
    const nestedValues = Array.isArray(value?.options)
      ? value.options
      : Array.isArray(value?.items)
        ? value.items
        : Array.isArray(value?.children)
          ? value.children
          : null;
    if (nestedValues) {
      flattened.push(...flattenConfigOptionValues(nestedValues));
      continue;
    }
    const normalized = normalizeConfigOptionValue(value);
    if (normalized) {
      flattened.push(normalized);
    }
  }
  return flattened;
}

function findConfigOption(configOptions, category, fallbackIds = []) {
  if (!Array.isArray(configOptions)) return null;
  return configOptions.find((option) => {
    const optionCategory = toNonEmptyString(option?.category);
    const optionId = toNonEmptyString(option?.id);
    return optionCategory === category || (optionId && fallbackIds.includes(optionId));
  }) || null;
}

function normalizeConfigOptionsModels(sessionInfo) {
  const configOptions = Array.isArray(sessionInfo?.configOptions)
    ? sessionInfo.configOptions
    : [];
  const modelOption = findConfigOption(configOptions, "model", ["model"]);
  const reasoningOption = findConfigOption(configOptions, "thought_level", [
    "reasoning_effort",
    "reasoning",
    "thought_level",
  ]);

  const modelValues = flattenConfigOptionValues(modelOption?.options);
  if (modelValues.length === 0) return null;

  const configuredThinkingLevels = flattenConfigOptionValues(reasoningOption?.options)
    .map((option) => option.id);
  const availableModelIds = Array.isArray(sessionInfo?.models?.availableModels)
    ? sessionInfo.models.availableModels
        .map((modelInfo) => toNonEmptyString(modelInfo?.modelId ?? modelInfo?.id))
        .filter(Boolean)
    : [];
  const availableModelIdSet = new Set(availableModelIds);
  const thinkingLevelsByModelId = new Map();
  for (const model of modelValues) {
    const validThinkingLevels = configuredThinkingLevels.length > 0
      ? configuredThinkingLevels.filter((level) => availableModelIdSet.has(`${model.id}/${level}`))
      : availableModelIds
          .filter((modelId) => modelId.startsWith(`${model.id}/`))
          .map((modelId) => modelId.slice(model.id.length + 1))
          .filter(Boolean);
    if (validThinkingLevels.length > 0) {
      thinkingLevelsByModelId.set(model.id, validThinkingLevels);
    }
  }

  const currentFromModels = toNonEmptyString(sessionInfo?.models?.currentModelId);
  const currentModel = toNonEmptyString(modelOption?.currentValue);
  const currentThinking = toNonEmptyString(reasoningOption?.currentValue);
  let currentModelId = currentFromModels;
  if (currentModel) {
    if (currentThinking && availableModelIdSet.has(`${currentModel}/${currentThinking}`)) {
      currentModelId = `${currentModel}/${currentThinking}`;
    } else if (!currentModelId || (currentModelId !== currentModel && !currentModelId.startsWith(`${currentModel}/`))) {
      currentModelId = currentModel;
    }
  }

  return {
    currentModelId: currentModelId || null,
    models: modelValues.map((model) => {
      const modelThinkingLevels = thinkingLevelsByModelId.get(model.id);
      return {
        ...model,
        ...(modelThinkingLevels ? { thinkingLevels: modelThinkingLevels } : {}),
      };
    }),
  };
}

function normalizeLegacySessionModels(sessionInfo) {
  const availableModels = Array.isArray(sessionInfo?.models?.availableModels)
    ? sessionInfo.models.availableModels
    : [];
  return {
    currentModelId: toNonEmptyString(sessionInfo?.models?.currentModelId),
    models: availableModels.map((modelInfo) => {
      const id = toNonEmptyString(modelInfo?.modelId ?? modelInfo?.id);
      if (!id) return null;
      return {
        id,
        name: toNonEmptyString(modelInfo?.name ?? modelInfo?.displayName) || id,
        description: toNonEmptyString(modelInfo?.description) || undefined,
      };
    }).filter(Boolean),
  };
}

function normalizeAcpSessionModels(sessionInfo) {
  return normalizeConfigOptionsModels(sessionInfo) || normalizeLegacySessionModels(sessionInfo);
}

module.exports = {
  normalizeAcpSessionModels,
};
