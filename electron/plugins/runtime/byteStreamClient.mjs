import { PluginError } from "@netcatty/plugin-sdk";
import { PLUGIN_BYTE_STREAM_FEATURE } from "@netcatty/plugin-contract";

export async function connectByteStream({ client, streams, subscriptions, enabledFeatures }, request, cancellationToken, viaHost = false) {
  if (!enabledFeatures.includes(PLUGIN_BYTE_STREAM_FEATURE)) throw new PluginError("unsupported", "Byte stream feature is unavailable");
  if (viaHost && !enabledFeatures.includes("network.host-byte-streams")) throw new PluginError("unsupported", "Host byte stream feature is unavailable");
  const descriptor = await client.request(viaHost ? "network.stream.connectViaHost" : "network.stream.connect", request, { cancellationToken, ...(viaHost ? { deadlineMs: 120_000 } : {}) });
  if (descriptor.cancelled) throw new PluginError("cancelled", "Host connection cancelled");
  let readable;
  let writable;
  let readablePromise;
  let closing;
  let cancellation;
  let connection;
  const close = () => {
    closing ??= client.request("network.stream.close", { handleId: descriptor.handleId })
      .finally(() => {
        cancellation?.dispose();
        streams.rejectReadable(descriptor.outputStreamId);
        if (connection) subscriptions.delete(connection);
      });
    return closing;
  };
  const cancel = () => { void close().catch(() => {}); };
  const checkCancelled = async () => {
    if (!cancellationToken?.isCancellationRequested) return;
    await close().catch(() => {});
    throw new PluginError("cancelled", "Byte stream connection cancelled");
  };
  try {
    await checkCancelled();
    readablePromise = streams.acceptReadable(descriptor.outputStreamId);
    void readablePromise.catch(() => {});
    writable = await streams.openWritable(descriptor.inputStreamId, descriptor.windowBytes);
    const attaching = client.request("network.stream.attach", { handleId: descriptor.handleId }, { cancellationToken });
    [readable] = await Promise.all([readablePromise, attaching]);
    await checkCancelled();
    connection = Object.freeze({
      endpoint: descriptor.endpoint,
      readable: Object.freeze({
        id: readable.id, read: () => readable.read(), cancel, dispose: cancel,
      }),
      writable: Object.freeze({
        id: writable.id, write: (bytes) => writable.write(bytes), end: () => writable.end(),
        fail: cancel, cancel, dispose: cancel,
      }),
      close, dispose: cancel,
    });
    cancellation = cancellationToken?.onCancellationRequested(cancel);
    subscriptions.add(connection);
    return connection;
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
