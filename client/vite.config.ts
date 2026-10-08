import { defineConfig, type Plugin } from 'vite';
import { NET } from '../shared/src/constants';
import type { LogEntry } from '../shared/src/log';
import { appendEntries, startLogFile } from '../tools/log-files';

/**
 * Dev-only: every browser POSTs its log batches to /__log and this writes them all to logs/client-latest.jsonl.
 * One file per dev-server start (the previous one is kept as client-prev.jsonl), shared by all browsers:
 * each line gets `session` (one page load) and `addr` (which computer), so two players' logs never overwrite each other.
 */
function logRelay(): Plugin {
  let file = '';
  return {
    name: 'log-relay',
    configureServer(server) {
      file = startLogFile('client');
      server.middlewares.use('/__log', (req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try {
            const batch = JSON.parse(body) as { session: string; entries: LogEntry[] };
            const addr = (req.socket.remoteAddress ?? '?').replace(/^::ffff:/, '');
            appendEntries(file, batch.entries.map((e) => ({ ...e, session: batch.session, addr })));
            res.statusCode = 204;
          } catch (err) {
            server.config.logger.error(`[log-relay] bad batch: ${String(err)}`);
            res.statusCode = 400;
          }
          res.end();
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [logRelay()],
  server: {
    port: NET.clientPort,
    strictPort: true,
    // host: true = also serve to other devices on the same network (not just this computer).
    host: true,
    // Everything goes through this one port: the game connection (/ws) and the room list (/rooms) are passed on
    // to the game server. Friends only need this one address, and the firewall only needs this one port.
    // xfwd: tell the game server each player's real address (it would otherwise see this proxy's address).
    proxy: {
      '/ws': { target: `ws://127.0.0.1:${NET.port}`, ws: true, xfwd: true },
      '/rooms': { target: `http://127.0.0.1:${NET.port}`, xfwd: true },
    },
  },
});
