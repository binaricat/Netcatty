# Shared SSH connection cancellation audit

Cancelling a transfer while its isolated SFTP channel is opening calls the
bounded-open abort path. Previously that path ended/destroyed the physical SSH
transport. Production pooled SFTP sessions normally share a terminal SSH
connection, so cancelling one transfer can disconnect terminals, browsing and
other transfers. The same teardown happened on the channel-open deadline.

The real startTransfer/cancelTransfer path reproduces physical end/destroy calls;
its old test double lacked those methods and could not detect the problem.

The repair rejects the abandoned caller promptly, retains the shared transport,
closes a channel arriving after abandonment, and blocks further channel-open
allocation on that transport while any abandoned request remains unresolved.
This bounds retry accumulation without queuing controls behind a transfer.
Healthy parallel opens remain allowed; callback settlement or transport closure
releases the abandoned-open bookkeeping. Existing active channels remain usable.

This separately reproduced mechanism is relevant to the connection-loss themes
in #2973 and #2832, but does not establish the cause of their VPN/jump-host reports.
