import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

export async function writeSystemManagerDiagnostic(
  message: string,
  extra?: Record<string, unknown>,
) {
  try {
    await netcattyBridge.get()?.logDiagnostic?.({
      source: 'system-manager',
      message,
      extra,
    });
  } catch {
    // Diagnostics must never block the user action being diagnosed.
  }
}
