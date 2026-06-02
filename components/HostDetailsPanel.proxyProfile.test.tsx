import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Trash2 } from "lucide-react";

import { I18nProvider } from "../application/i18n/I18nProvider.tsx";
import type { Host, SSHKey } from "../types.ts";
import { HostDetailsConnectionSections } from "./HostDetailsConnectionSections.tsx";
import HostDetailsPanel, { parseOptionalPortInput } from "./HostDetailsPanel.tsx";
import { TooltipProvider } from "./ui/tooltip.tsx";

const hostWithMissingProxyProfile: Host = {
  id: "host-1",
  label: "DB",
  hostname: "db.example.com",
  username: "root",
  tags: [],
  os: "linux",
  port: 22,
  protocol: "ssh",
  authMethod: "password",
  proxyProfileId: "missing-proxy",
  createdAt: 1,
};

const referenceKey: SSHKey = {
  id: "reference-key-1",
  label: "id_ed25519",
  type: "ED25519",
  privateKey: "",
  source: "reference",
  category: "key",
  created: 1,
  filePath: "/Users/alice/.ssh/id_ed25519",
};

const importedKey: SSHKey = {
  id: "imported-key-1",
  label: "Imported Key",
  type: "ED25519",
  privateKey: "PRIVATE KEY",
  source: "imported",
  category: "key",
  created: 1,
};

const renderHostDetails = (
  initialData: Host = hostWithMissingProxyProfile,
  availableKeys: SSHKey[] = [],
) =>
  renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(HostDetailsPanel, {
          initialData,
          availableKeys,
          identities: [],
          proxyProfiles: [],
          groups: [],
          managedSources: [],
          allTags: [],
          allHosts: [],
          terminalThemeId: "default",
          terminalFontSize: 14,
          onSave: () => {},
          onCancel: () => {},
        }),
      ),
    ),
  );

type InspectableElementProps = {
  children?: React.ReactNode;
  className?: string;
  onClick?: () => void;
};
type ConnectionSectionProps = React.ComponentProps<typeof HostDetailsConnectionSections>;

const createConnectionSectionProps = (
  overrides: Partial<ConnectionSectionProps> = {},
): ConnectionSectionProps => ({
  t: (key: string) => key,
  form: {
    ...hostWithMissingProxyProfile,
    proxyProfileId: undefined,
    os: "windows",
    password: undefined,
  },
  update: () => {},
  groupDefaults: undefined,
  selectedIdentity: undefined,
  clearIdentity: () => {},
  identities: [],
  identitySuggestionsOpen: false,
  filteredIdentitySuggestions: [],
  setIdentitySuggestionsOpen: () => {},
  availableKeys: [],
  applyIdentity: () => {},
  showPassword: false,
  setShowPassword: () => {},
  pendingReferenceKeyPath: null,
  setPendingReferenceKeyPath: () => {},
  selectedCredentialType: null,
  setSelectedCredentialType: () => {},
  credentialPopoverOpen: true,
  setCredentialPopoverOpen: () => {},
  keysByCategory: { key: [], certificate: [], identity: [] },
  newKeyFilePath: "",
  setNewKeyFilePath: () => {},
  addLocalKeyFilePath: () => {},
  handleDistroModeChange: () => {},
  distroOptions: [],
  effectiveFormDistro: undefined,
  getDistroOptionLabel: (value?: string) => value || "",
  ...overrides,
});

const collectText = (node: React.ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(collectText).join("");
  }
  if (!React.isValidElement<InspectableElementProps>(node)) {
    return "";
  }
  return collectText(node.props.children);
};

const containsElementType = (
  node: React.ReactNode,
  type: React.ElementType,
): boolean => {
  if (Array.isArray(node)) {
    return node.some((child) => containsElementType(child, type));
  }
  if (!React.isValidElement<InspectableElementProps>(node)) {
    return false;
  }
  return node.type === type || containsElementType(node.props.children, type);
};

const findElement = (
  node: React.ReactNode,
  predicate: (element: React.ReactElement<InspectableElementProps>) => boolean,
): React.ReactElement<InspectableElementProps> | undefined => {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate);
      if (match) return match;
    }
    return undefined;
  }
  if (!React.isValidElement<InspectableElementProps>(node)) {
    return undefined;
  }
  if (predicate(node)) {
    return node;
  }
  return findElement(node.props.children, predicate);
};

const findInputByValue = (markup: string, value: string) => {
  const match = markup.match(new RegExp(`<input(?=[^>]*value="${value}")[^>]*>`));
  assert.ok(match, `expected input with value ${value}`);
  return match[0];
};

const classTokens = (markup: string) => {
  const classMatch = markup.match(/class="([^"]*)"/);
  assert.ok(classMatch, "expected class attribute");
  return new Set(classMatch[1].split(/\s+/).filter(Boolean));
};

test("HostDetailsPanel shows a missing saved proxy without undefined fields", () => {
  const markup = renderHostDetails();

  assert.match(markup, /Missing saved proxy/);
  assert.doesNotMatch(markup, /undefined:undefined/);
});

test("HostDetailsPanel keeps explicitly cleared telnet credentials empty", () => {
  const markup = renderHostDetails({
    ...hostWithMissingProxyProfile,
    protocol: "telnet",
    telnetEnabled: true,
    telnetPort: 23,
    username: "root",
    password: "ssh-password",
    telnetUsername: "",
    telnetPassword: "",
    proxyProfileId: undefined,
  });

  assert.match(markup, /placeholder="Telnet Username"[^>]*value=""/);
  assert.match(markup, /placeholder="Telnet Password"[^>]*value=""/);
  assert.doesNotMatch(markup, /placeholder="Telnet Username"[^>]*value="root"/);
  assert.doesNotMatch(markup, /placeholder="Telnet Password"[^>]*value="ssh-password"/);
});

test("HostDetailsPanel gives the telnet port field the same roomy layout as SSH", () => {
  const markup = renderHostDetails({
    ...hostWithMissingProxyProfile,
    protocol: "telnet",
    telnetEnabled: true,
    telnetPort: 2325,
    proxyProfileId: undefined,
  });

  const telnetMarkup = markup.slice(markup.indexOf("Telnet on"));
  const wrapperMatch = telnetMarkup.match(/<div class="([^"]*w-1\/2[^"]*)"/);
  assert.ok(wrapperMatch, "expected telnet port wrapper");
  const wrapperClasses = new Set(wrapperMatch[1].split(/\s+/).filter(Boolean));
  assert.ok(wrapperClasses.has("ml-auto"));
  assert.ok(wrapperClasses.has("w-1/2"));
  assert.ok(wrapperClasses.has("min-w-0"));
  assert.ok(wrapperClasses.has("justify-end"));
  const telnetPortInput = findInputByValue(markup, "2325");
  const inputClasses = classTokens(telnetPortInput);
  assert.ok(inputClasses.has("flex-1"));
  assert.ok(inputClasses.has("min-w-0"));
  assert.ok(inputClasses.has("text-center"));
  assert.equal(inputClasses.has("w-16"), false);
});

test("HostDetailsPanel displays inherited telnet port before falling back to 23", () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(HostDetailsPanel, {
          initialData: {
            ...hostWithMissingProxyProfile,
            protocol: "telnet",
            telnetEnabled: true,
            telnetPort: undefined,
            port: undefined,
            group: "network",
            proxyProfileId: undefined,
          },
          availableKeys: [],
          identities: [],
          proxyProfiles: [],
          groups: ["network"],
          managedSources: [],
          allTags: [],
          allHosts: [],
          terminalThemeId: "default",
          terminalFontSize: 14,
          groupConfigs: [{ path: "network", telnetPort: 2325 }],
          onSave: () => {},
          onCancel: () => {},
        }),
      ),
    ),
  );

  assert.match(findInputByValue(markup, "2325"), /type="number"/);
});

test("HostDetailsPanel uses group telnet port instead of ssh port for optional telnet", () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(HostDetailsPanel, {
          initialData: {
            ...hostWithMissingProxyProfile,
            protocol: "ssh",
            telnetEnabled: true,
            telnetPort: undefined,
            port: 2222,
            group: "network",
            proxyProfileId: undefined,
          },
          availableKeys: [],
          identities: [],
          proxyProfiles: [],
          groups: ["network"],
          managedSources: [],
          allTags: [],
          allHosts: [],
          terminalThemeId: "default",
          terminalFontSize: 14,
          groupConfigs: [{ path: "network", telnetPort: 2325 }],
          onSave: () => {},
          onCancel: () => {},
        }),
      ),
    ),
  );

  const telnetMarkup = markup.slice(markup.indexOf("Telnet on"));
  assert.match(findInputByValue(telnetMarkup, "2325"), /type="number"/);
  assert.doesNotMatch(telnetMarkup, /value="2222"/);
});

test("HostDetailsPanel displays inherited telnet credentials", () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: "en" },
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(HostDetailsPanel, {
          initialData: {
            ...hostWithMissingProxyProfile,
            protocol: "telnet",
            telnetEnabled: true,
            telnetUsername: undefined,
            telnetPassword: undefined,
            username: "ssh-user",
            password: "ssh-password",
            group: "network",
            proxyProfileId: undefined,
          },
          availableKeys: [],
          identities: [],
          proxyProfiles: [],
          groups: ["network"],
          managedSources: [],
          allTags: [],
          allHosts: [],
          terminalThemeId: "default",
          terminalFontSize: 14,
          groupConfigs: [{
            path: "network",
            telnetUsername: "group-telnet-user",
            telnetPassword: "group-telnet-password",
          }],
          onSave: () => {},
          onCancel: () => {},
        }),
      ),
    ),
  );

  assert.match(markup, /placeholder="Telnet Username"[^>]*value="group-telnet-user"/);
  assert.match(markup, /placeholder="Telnet Password"[^>]*value="group-telnet-password"/);
  assert.doesNotMatch(markup, /placeholder="Telnet Username"[^>]*value="ssh-user"/);
  assert.doesNotMatch(markup, /placeholder="Telnet Password"[^>]*value="ssh-password"/);
});

test("HostDetailsPanel displays saved reference key identity paths as local key files", () => {
  const markup = renderHostDetails(
    {
      ...hostWithMissingProxyProfile,
      proxyProfileId: undefined,
      authMethod: "key",
      identityFileId: referenceKey.id,
      identityFilePaths: [referenceKey.filePath!],
      password: undefined,
    },
    [referenceKey],
  );

  assert.match(markup, /\/Users\/alice\/\.ssh\/id_ed25519/);
  assert.match(markup, /placeholder="Password"/);
});

test("HostDetailsPanel falls back to reference key filePath when host paths are missing", () => {
  const markup = renderHostDetails(
    {
      ...hostWithMissingProxyProfile,
      proxyProfileId: undefined,
      authMethod: "key",
      identityFileId: referenceKey.id,
      identityFilePaths: undefined,
      password: undefined,
    },
    [referenceKey],
  );

  assert.match(markup, /\/Users\/alice\/\.ssh\/id_ed25519/);
});

test("HostDetailsPanel keeps imported keys in the regular key display", () => {
  const markup = renderHostDetails(
    {
      ...hostWithMissingProxyProfile,
      proxyProfileId: undefined,
      authMethod: "key",
      identityFileId: importedKey.id,
      identityFilePaths: ["/Users/alice/.ssh/stale_ed25519"],
      password: undefined,
    },
    [importedKey],
  );

  assert.match(markup, /Imported Key/);
  assert.doesNotMatch(markup, /\/Users\/alice\/\.ssh\/stale_ed25519/);
});

test("HostDetailsPanel displays default local key auth when no concrete key path is saved", () => {
  const markup = renderHostDetails({
    ...hostWithMissingProxyProfile,
    proxyProfileId: undefined,
    authMethod: "key",
    identityFileId: undefined,
    identityFilePaths: undefined,
    password: undefined,
  });

  assert.match(markup, /Local SSH key \/ SSH Agent/);
  assert.doesNotMatch(markup, /Key, Certificate, Local Key File/);
  assert.match(markup, /placeholder="Password"/);
});

test("HostDetailsConnectionSections waits for a local key file path before enabling key auth", () => {
  const updateCalls: Array<[keyof Host, Host[keyof Host]]> = [];
  const selectedTypes: Array<string | null> = [];
  const props = createConnectionSectionProps({
    update: <K extends keyof Host>(key: K, value: Host[K]) => {
      updateCalls.push([key, value]);
    },
    setSelectedCredentialType: (type: string | null) => {
      selectedTypes.push(type);
    },
  });

  const tree = HostDetailsConnectionSections(props);
  const localKeyFileButton = findElement(
    tree,
    (element) =>
      element.type === "button" &&
      collectText(element.props.children).includes("hostDetails.credential.localKeyFile"),
  );

  assert.ok(localKeyFileButton?.props.onClick, "expected local key file option");
  localKeyFileButton.props.onClick();

  assert.deepEqual(selectedTypes, ["localKeyFile"]);
  assert.deepEqual(
    updateCalls.filter(([key]) => key === "authMethod"),
    [],
  );
});

test("HostDetailsConnectionSections keeps key auth when deleting a reference key with paths remaining", () => {
  const remainingPath = "/Users/alice/.ssh/backup_ed25519";
  const updateCalls: Array<[keyof Host, Host[keyof Host]]> = [];
  const props = createConnectionSectionProps({
    form: {
      ...hostWithMissingProxyProfile,
      proxyProfileId: undefined,
      os: "windows",
      authMethod: "key",
      identityFileId: referenceKey.id,
      identityFilePaths: [referenceKey.filePath!, remainingPath],
      password: undefined,
    },
    availableKeys: [referenceKey],
    update: <K extends keyof Host>(key: K, value: Host[K]) => {
      updateCalls.push([key, value]);
    },
  });

  const tree = HostDetailsConnectionSections(props);
  const deleteReferenceKeyButton = findElement(
    tree,
    (element) =>
      typeof element.props.onClick === "function" &&
      containsElementType(element.props.children, Trash2),
  );

  assert.ok(deleteReferenceKeyButton?.props.onClick, "expected reference key delete button");
  deleteReferenceKeyButton.props.onClick();

  assert.deepEqual(
    updateCalls.find(([key]) => key === "identityFileId"),
    ["identityFileId", undefined],
  );
  assert.deepEqual(
    updateCalls.find(([key]) => key === "identityFilePaths"),
    ["identityFilePaths", [remainingPath]],
  );
  assert.deepEqual(
    updateCalls.filter(([key]) => key === "authMethod"),
    [["authMethod", "key"]],
  );
});

test("parseOptionalPortInput clears empty port values", () => {
  assert.equal(parseOptionalPortInput(""), undefined);
  assert.equal(parseOptionalPortInput("2325"), 2325);
});

test("HostDetailsPanel does not offer to disable telnet when telnet is the primary protocol", () => {
  const markup = renderHostDetails({
    ...hostWithMissingProxyProfile,
    protocol: "telnet",
    telnetEnabled: true,
    telnetPort: 23,
    proxyProfileId: undefined,
  });
  const telnetHeader = markup.match(/Telnet on[\s\S]*?Credentials/);

  assert.ok(telnetHeader);
  assert.doesNotMatch(telnetHeader[0], /hover:text-destructive/);
});
