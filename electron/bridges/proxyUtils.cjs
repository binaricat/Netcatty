/**
 * Proxy Utilities - Shared proxy socket creation for SSH connections
 * Extracted from sshBridge.cjs and sftpBridge.cjs to eliminate code duplication
 */

const net = require("node:net");
const { enableTcpNoDelay } = require("./tcpNoDelay.cjs");

/**
 * Create a socket through a proxy (HTTP CONNECT or SOCKS5)
 * @param {Object} proxy - Proxy configuration
 * @param {string} proxy.type - 'http' or 'socks5'
 * @param {string} proxy.host - Proxy host
 * @param {number} proxy.port - Proxy port
 * @param {string} [proxy.username] - Optional username for auth
 * @param {string} [proxy.password] - Optional password for auth
 * @param {string} targetHost - Target host to connect through proxy
 * @param {number} targetPort - Target port to connect through proxy
 * @param {Object} [options]
 * @param {(socket: net.Socket) => void} [options.onSocket] - Called immediately with the underlying socket
 * @returns {Promise<net.Socket>} Connected socket through proxy
 */
function createProxySocket(proxy, targetHost, targetPort, options = {}) {
    const { onSocket } = options;
    return new Promise((resolve, reject) => {
        if (proxy.type === 'http') {
            // HTTP CONNECT proxy
            const socket = net.connect(proxy.port, proxy.host, () => {
                enableTcpNoDelay(socket);
                let authHeader = '';
                if (proxy.username && proxy.password) {
                    const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
                    authHeader = `Proxy-Authorization: Basic ${auth}\r\n`;
                }
                const connectRequest = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${authHeader}\r\n`;
                socket.write(connectRequest);

                let response = '';
                const onData = (data) => {
                    response += data.toString();
                    if (response.includes('\r\n\r\n')) {
                        socket.removeListener('data', onData);
                        if (response.startsWith('HTTP/1.1 200') || response.startsWith('HTTP/1.0 200')) {
                            resolve(socket);
                        } else {
                            socket.destroy();
                            reject(new Error(`HTTP proxy error: ${response.split('\r\n')[0]}`));
                        }
                    }
                };
                socket.on('data', onData);
            });
            enableTcpNoDelay(socket);
            try { onSocket?.(socket); } catch { /* ignore */ }
            socket.on('error', reject);
        } else if (proxy.type === 'socks5') {
            // SOCKS5 proxy
            const socket = net.connect(proxy.port, proxy.host, () => {
                enableTcpNoDelay(socket);
                // SOCKS5 greeting
                const authMethods = proxy.username && proxy.password ? [0x00, 0x02] : [0x00];
                socket.write(Buffer.from([0x05, authMethods.length, ...authMethods]));

                let step = 'greeting';
                const onData = (data) => {
                    if (step === 'greeting') {
                        if (data[0] !== 0x05) {
                            socket.destroy();
                            reject(new Error('Invalid SOCKS5 response'));
                            return;
                        }
                        const method = data[1];
                        if (method === 0x02 && proxy.username && proxy.password) {
                            // Username/password auth
                            step = 'auth';
                            const userBuf = Buffer.from(proxy.username);
                            const passBuf = Buffer.from(proxy.password);
                            socket.write(Buffer.concat([
                                Buffer.from([0x01, userBuf.length]),
                                userBuf,
                                Buffer.from([passBuf.length]),
                                passBuf
                            ]));
                        } else if (method === 0x00) {
                            // No auth, proceed to connect
                            step = 'connect';
                            sendConnectRequest();
                        } else {
                            socket.destroy();
                            reject(new Error('SOCKS5 authentication method not supported'));
                        }
                    } else if (step === 'auth') {
                        if (data[1] !== 0x00) {
                            socket.destroy();
                            reject(new Error('SOCKS5 authentication failed'));
                            return;
                        }
                        step = 'connect';
                        sendConnectRequest();
                    } else if (step === 'connect') {
                        socket.removeListener('data', onData);
                        if (data[1] === 0x00) {
                            resolve(socket);
                        } else {
                            const errors = {
                                0x01: 'General failure',
                                0x02: 'Connection not allowed',
                                0x03: 'Network unreachable',
                                0x04: 'Host unreachable',
                                0x05: 'Connection refused',
                                0x06: 'TTL expired',
                                0x07: 'Command not supported',
                                0x08: 'Address type not supported',
                            };
                            socket.destroy();
                            reject(new Error(`SOCKS5 error: ${errors[data[1]] || 'Unknown'}`));
                        }
                    }
                };

                const sendConnectRequest = () => {
                    // SOCKS5 connect request
                    const hostBuf = Buffer.from(targetHost);
                    const request = Buffer.concat([
                        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
                        hostBuf,
                        Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff])
                    ]);
                    socket.write(request);
                };

                socket.on('data', onData);
            });
            enableTcpNoDelay(socket);
            try { onSocket?.(socket); } catch { /* ignore */ }
            socket.on('error', reject);
        } else {
            reject(new Error(`Unknown proxy type: ${proxy.type}`));
        }
    });
}

module.exports = {
    createProxySocket,
};
