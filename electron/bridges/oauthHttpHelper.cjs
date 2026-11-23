"use strict";

const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;

const safeJsonParse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const describeNetworkError = (err) => {
  const msg = err?.message || String(err);
  const cause = err?.cause;
  const causeCode = cause?.code ? ` (${cause.code})` : "";
  const causeMsg = cause?.message ? `: ${cause.message}` : "";
  return `${msg}${causeCode}${causeMsg}`.trim();
};

const resolveFetch = (electronModule) =>
  electronModule?.net?.fetch ? electronModule.net.fetch.bind(electronModule.net) : fetch;

/**
 * Execute an x-www-form-urlencoded POST to an OAuth endpoint and parse the JSON
 * response, surfacing standardized network / HTTP / invalid-JSON errors.
 */
async function postOAuthForm(fetchImpl, url, params, {
  label,
  serviceLabel,
  signal,
  formatHttpError,
}) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      ...(signal ? { signal } : {}),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
  } catch (err) {
    if (serviceLabel) {
      throw new Error(
        `${label} network error. Check your network/VPN and whether ${serviceLabel} are reachable. (${describeNetworkError(err)})`
      );
    }
    throw err;
  }

  const text = await res.text();
  if (!res.ok) {
    if (typeof formatHttpError === "function") {
      throw new Error(formatHttpError(res.status, text));
    }
    const data = safeJsonParse(text) || { error: text };
    throw new Error(`${label} failed: ${data.error_description || data.error || res.status}`);
  }

  const data = safeJsonParse(text);
  if (!data) {
    throw new Error(`${label} invalid JSON: ${text.slice(0, 200)}`);
  }

  return data;
}

module.exports = {
  isNonEmptyString,
  safeJsonParse,
  describeNetworkError,
  resolveFetch,
  postOAuthForm,
};
