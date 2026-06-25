"use strict";

/**
 * Shared capability layer types (JSDoc only).
 *
 * @typedef {import('./constants.cjs').CapabilitySurface} CapabilitySurface
 * @typedef {import('./constants.cjs').CapabilityStatus} CapabilityStatus
 * @typedef {import('./constants.cjs').PermissionMode} PermissionMode
 * @typedef {import('./constants.cjs').AgentKind} AgentKind
 *
 * @typedef {Object} CapabilitySurfaceBinding
 * @property {string} [rpcMethod]
 * @property {string} [mcpTool]
 * @property {string} [toolName]
 * @property {string[]} [command]
 * @property {boolean} [confirmInConfirmMode]
 *
 * @typedef {Object} CapabilityPolicy
 * @property {boolean} write
 * @property {boolean} sensitiveRead
 * @property {boolean} longRunning
 * @property {boolean} requiresChatSession
 * @property {boolean} bypassesObserverBlock
 * @property {boolean} bypassesApproval
 * @property {boolean} bypassesChatCancel
 *
 * @typedef {Object} CapabilityDefinition
 * @property {string} id
 * @property {string} domain
 * @property {CapabilityStatus} status
 * @property {string} description
 * @property {CapabilityPolicy} policy
 * @property {Partial<Record<CapabilitySurface, CapabilitySurfaceBinding>>} surfaces
 * @property {AgentKind[]} [agentKinds] Explicit agent placement; inferred when omitted (see resolveAgentKinds).
 *
 * @typedef {Object} RpcPermissionContext
 * @property {boolean} [chatSessionCancelled]
 *
 * @typedef {Object} RpcPermissionDecision
 * @property {boolean} allowed
 * @property {boolean} requiresApproval
 * @property {string} [error]
 * @property {CapabilityDefinition} [capability]
 */

module.exports = {};
