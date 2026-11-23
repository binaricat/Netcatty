"use strict";

const net = require("node:net");

function closeReasoning(state, emitter) {
  if (state?.reasoningOpen) {
    emitter.reasoningEnd();
    state.reasoningOpen = false;
  }
}

function getAvailablePort(host = "127.0.0.1", avoidPort = 0) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(avoidPort && port === avoidPort ? getAvailablePort(host, avoidPort) : port);
      });
    });
  });
}

module.exports = {
  closeReasoning,
  getAvailablePort,
};
