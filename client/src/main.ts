import Phaser from 'phaser';
import { arenaById, arenaLayout, BACKYARD, GAME_SPEED, initPhysics, setGameSpeed, type Logger } from '@ragdoll/shared';
import { VIEW } from './camera';
import { SCENE } from './skin';
import { GameScene } from './GameScene';
import { NetClient } from './net-client';
import { NetScene } from './NetScene';
import { HatProgress } from './progress';
import { createRemoteLogger } from './remote-log';
import { serverWs } from './server-url';
import { Menu, type JoinRequest } from './menu/menu';
import { startCoverArt } from './menu/cover';

const params = new URLSearchParams(location.search);

function startGame(scene: Phaser.Scene): Phaser.Game {
  return new Phaser.Game({
    type: Phaser.AUTO,
    width: VIEW.width,
    height: VIEW.height,
    backgroundColor: SCENE.background,
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene,
  });
}

/**
 * Online: the home page (M4) -> connect -> online scene. A lost connection (or leaving) brings the home page back,
 * and the game behind it is torn down.
 */
async function showMenu(log: Logger): Promise<void> {
  await initPhysics(); // (the menu's live background and character preview run real physics)
  const progress = HatProgress.load(log);
  addEventListener('pagehide', () => progress.save());
  const lag = { ms: Number(params.get('lag')) || 0, jitter: Number(params.get('jitter')) || 0 };
  const url = serverWs();
  const menu: Menu = new Menu(log, progress, async (req: JoinRequest) => {
    const net = await NetClient.connect(url, req.name, log, lag, req.room, req.hat, req.settings);
    menu.hide();
    // (the address bar carries the room code, so the link can be shared as an invite)
    const link = new URLSearchParams(location.search);
    link.set('room', net.welcome.room);
    history.replaceState(null, '', `?${link}`);
    const game = startGame(new NetScene(log, net, menu.shareUrl, progress));
    const watch = setInterval(() => {
      if (!net.closed) return;
      clearInterval(watch);
      game.destroy(true);
      progress.save();
      const left = net.closed.reason === 'left';
      if (left) {
        // M6: left on purpose: the room code leaves the address bar too (a reload shouldn't send you back in)
        const link = new URLSearchParams(location.search);
        link.delete('room');
        history.replaceState(null, '', link.size ? `?${link}` : location.pathname);
      }
      const why = left ? '' : `Disconnected: ${net.closed.reason}.`;
      menu.show(why);
    }, 500);
  });
  menu.show();
}

async function main(): Promise<void> {
  const log = createRemoteLogger();
  const mode = params.get('mode');
  if (mode === 'local') {
    await initPhysics();
    // L7 game-speed dial offline: ?speed=0.85
    const speed = params.get('speed');
    if (speed !== null && !setGameSpeed(Number(speed))) log.warn('bad_game_speed', { got: speed, using: GAME_SPEED });
    log.info('game_speed', { speed: GAME_SPEED, offline: true });
    // Offline arena: ?arena=test_lab&size=narrow (default: the Backyard, full size); ?bot=1: the other player is a bot.
    const def = arenaById(params.get('arena') ?? '') ?? BACKYARD;
    startGame(new GameScene(log, arenaLayout(def, params.get('size') === 'narrow' ? 'narrow' : 'full'), params.get('bot') === '1'));
  } else if (mode === 'cover') {
    await initPhysics();
    startCoverArt(log);
  } else {
    await showMenu(log);
  }
}

main();
