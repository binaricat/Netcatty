import {
  type PluginManifest,
} from "@netcatty/plugin-contract";
import { satisfies, valid, validRange } from "semver";

const DEFAULT_PLUGIN_API_VERSION = "0.1.0-internal.1";

export interface PluginCompatibilityTarget {
  readonly netcattyVersion: string;
  readonly apiVersion?: string;
  readonly features?: readonly string[];
}

export interface PluginCompatibilityResult {
  readonly compatible: boolean;
  readonly apiVersion: string;
  readonly enabledFeatures: readonly string[];
  readonly missingRequiredFeatures: readonly string[];
  readonly errors: readonly string[];
}

function checkEngineVersion(
  label: string,
  version: string,
  range: string,
  errors: string[],
): void {
  if (valid(version) === null) {
    errors.push(`Host ${label} version is not valid semver: ${version}`);
    return;
  }
  const normalizedRange = validRange(range);
  if (normalizedRange === null) {
    errors.push(`Plugin ${label} range is not valid semver: ${range}`);
    return;
  }
  if (!satisfies(version, normalizedRange)) {
    errors.push(`Host ${label} version ${version} does not satisfy ${range}`);
  }
}

export function checkPluginCompatibility(
  manifest: PluginManifest,
  target: PluginCompatibilityTarget,
): PluginCompatibilityResult {
  let apiVersion = target.apiVersion ?? DEFAULT_PLUGIN_API_VERSION;
  // This host still offers the previous, unchanged wire contract to legacy packages.
  // Never negotiate new brand metadata down to a host revision that cannot validate it.
  if (apiVersion === DEFAULT_PLUGIN_API_VERSION && !manifest.icon
    && !satisfies(apiVersion, manifest.engines.api) && satisfies('0.1.0-internal', manifest.engines.api)) {
    apiVersion = '0.1.0-internal';
  }
  const errors: string[] = [];
  checkEngineVersion("Netcatty", target.netcattyVersion, manifest.engines.netcatty, errors);
  checkEngineVersion("plugin API", apiVersion, manifest.engines.api, errors);

  const supportedFeatures = new Set(target.features ?? []);
  const requiredFeatures = manifest.features?.required ?? [];
  const optionalFeatures = manifest.features?.optional ?? [];
  const missingRequiredFeatures = requiredFeatures
    .filter((feature) => !supportedFeatures.has(feature))
    .sort((left, right) => left.localeCompare(right, "en"));
  if (missingRequiredFeatures.length > 0) {
    errors.push(`Missing required features: ${missingRequiredFeatures.join(", ")}`);
  }

  const enabledFeatures = [...new Set([...requiredFeatures, ...optionalFeatures])]
    .filter((feature) => supportedFeatures.has(feature))
    .sort((left, right) => left.localeCompare(right, "en"));

  return {
    compatible: errors.length === 0,
    apiVersion,
    enabledFeatures,
    missingRequiredFeatures,
    errors,
  };
}
