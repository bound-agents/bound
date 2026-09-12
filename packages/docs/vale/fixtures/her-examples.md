The reconnect drain only re-sends on a fresh connection, so a persistently-connected sender whose ack was dropped has no automatic retry.

On the receive side, the receiver classifies each entry's insert by fault.
