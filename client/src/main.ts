import Phaser from 'phaser';
import { arenaById, arenaLayout, BACKYARD, GAME_SPEED, HATS, initPhysics, isHat, setGameSpeed, type HatKind, type Logger, type RoomList } from '@ragdoll/shared';
import { VIEW } from './camera';
import { SCENE } from './skin';
import { GameScene } from './GameScene';
import { NetClient } from './net-client';
import { NetScene } from './NetScene';
import { HatProgress, savedHat, saveHat } from './progress';
import { createRemoteLogger } from './remote-log';

const params = new URLSearchParams(location.search);
const NAME_KEY = 'ragdoll.name';
const ROOMS_REFRESH_MS = 2000;
/** The page's own address: the dev server passes /ws and /rooms on to the game server (one address, one port). */
const serverHost = location.host;

function startGame(scene: Phaser.Scene): void {
  new Phaser.Game({
    type: Phaser.AUTO,
    width: VIEW.width,
    height: VIEW.height,
    backgroundColor: SCENE.background,
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene,
  });
}

/** Online: name + room list -> connect -> online scene. A lost connection brings the screen back. */
function showJoin(log: Logger): void {
  const panel = document.getElementById('join')!;
  const form = document.getElementById('join-form') as HTMLFormElement;
  const nameInput = document.getElementById('name') as HTMLInputElement;
  const buttons = [document.getElementById('play') as HTMLButtonElement, document.getElementById('new-room') as HTMLButtonElement];
  const roomsList = document.getElementById('rooms')!;
  const share = document.getElementById('share')!;
  const status = document.getElementById('status')!;
  const hatSelect = document.getElementById('hat') as HTMLSelectElement;
  const hatHelp = document.getElementById('hat-help')!;
  const progress = HatProgress.load(log);
  addEventListener('pagehide', () => progress.save());
  // Every hat is listed; locked ones say how to unlock them.
  hatSelect.replaceChildren(
    ...HATS.map((h) => {
      const open = h.unlocked(progress.p);
      return Object.assign(document.createElement('option'), { value: h.kind, disabled: !open, textContent: open ? h.name : `${h.name} (locked: ${h.how})` });
    }),
  );
  hatSelect.value = savedHat(progress.p);
  const locked = HATS.filter((h) => !h.unlocked(progress.p)).length;
  hatHelp.textContent = locked ? `${locked} hats still locked. Play to unlock them.` : 'All hats unlocked!';
  try {
    nameInput.value = localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    /* storage blocked: just start empty */
  }
  panel.hidden = false;
  nameInput.focus();
  let busy = false;
  let lastRoomsError = '';
  /** Address other devices should open (shown in the game HUD too). */
  let shareUrl = '';

  const join = async (room?: string) => {
    if (busy) return;
    const name = nameInput.value.trim() || 'archer';
    const hat: HatKind = isHat(hatSelect.value) ? hatSelect.value : 'none';
    saveHat(hat);
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      /* not important */
    }
    busy = true;
    buttons.forEach((b) => (b.disabled = true));
    status.textContent = 'Connecting...';
    const lag = { ms: Number(params.get('lag')) || 0, jitter: Number(params.get('jitter')) || 0 };
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${serverHost}/ws`;
    try {
      const net = await NetClient.connect(url, name, log, lag, room, hat);
      clearInterval(refresher);
      panel.hidden = true;
      startGame(new NetScene(log, net, shareUrl, progress));
      const watch = setInterval(() => {
        if (!net.closed) return;
        clearInterval(watch);
        status.textContent = `Disconnected: ${net.closed.reason}. Reload the page to play again.`;
        panel.hidden = false;
      }, 500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('join_failed', { msg, room: room ?? 'quick' });
      status.textContent = msg.includes("can't reach")
        ? `${msg}. Is the server running (npm run dev)?`
        : msg === 'room_full'
          ? 'That room is full. Pick another or make a new one.'
          : msg === 'room_not_found'
            ? 'That room just closed. Pick another or make a new one.'
            : `Couldn't join: ${msg}`;
      busy = false;
      buttons.forEach((b) => (b.disabled = false));
      void refreshRooms();
    }
  };

  /** Reads the room list from the game server and redraws it (also shows the address friends should open). */
  const refreshRooms = async () => {
    try {
      const res = await fetch('/rooms');
      const list = (await res.json()) as RoomList;
      lastRoomsError = '';
      roomsList.replaceChildren(
        ...(list.rooms.length
          ? list.rooms.map((r) => {
              const li = document.createElement('li');
              const who = document.createElement('span');
              who.className = 'who';
              who.innerHTML = `<b>Room ${r.id.slice(1)}</b> · ${r.players.length}/${r.max}`;
              who.append(r.players.length ? ` · ${r.players.join(', ')}` : '');
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.textContent = r.players.length >= r.max ? 'Full' : 'Join';
              btn.disabled = busy || r.players.length >= r.max;
              btn.onclick = () => join(r.id);
              li.append(who, btn);
              return li;
            })
          : [Object.assign(document.createElement('li'), { className: 'empty', textContent: 'No rooms yet. Quick play or New room starts one.' })]),
      );
      const here = list.lanUrls.find((u) => u.includes(location.hostname));
      const urls = here ? [here] : list.lanUrls;
      shareUrl = urls[0] ?? '';
      share.innerHTML = urls.length ? `Friends on the same network open: ${urls.map((u) => `<code>${u}</code>`).join(' or ')}` : '';
    } catch (err) {
      const msg = `Can't reach the game server (via ${serverHost}/rooms). Is it running (npm run dev)?`;
      roomsList.replaceChildren(Object.assign(document.createElement('li'), { className: 'empty', textContent: msg }));
      if (lastRoomsError !== msg) log.warn('rooms_unreachable', { host: serverHost, err: String(err) });
      lastRoomsError = msg;
    }
  };

  form.onsubmit = (e) => {
    e.preventDefault();
    void join();
  };
  buttons[1].onclick = () => void join('new');
  void refreshRooms();
  const refresher = setInterval(refreshRooms, ROOMS_REFRESH_MS);
}

async function main(): Promise<void> {
  const log = createRemoteLogger();
  if (params.get('mode') === 'local') {
    await initPhysics();
    // L7 game-speed dial offline: ?speed=0.85
    const speed = params.get('speed');
    if (speed !== null && !setGameSpeed(Number(speed))) log.warn('bad_game_speed', { got: speed, using: GAME_SPEED });
    log.info('game_speed', { speed: GAME_SPEED, offline: true });
    // Offline arena: ?arena=test_lab&size=narrow (default: the Backyard, full size).
    const def = arenaById(params.get('arena') ?? '') ?? BACKYARD;
    startGame(new GameScene(log, arenaLayout(def, params.get('size') === 'narrow' ? 'narrow' : 'full')));
  } else {
    showJoin(log);
  }
}

main();
