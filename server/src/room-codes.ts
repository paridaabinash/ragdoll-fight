/**
 * M1: room codes. Short, friendly words a friend can read out loud ("join FROG"); random letters only when every word
 * is taken. Words are checked by hand: nothing rude, nothing that reads badly.
 */
const WORDS = (
  'FROG BOLT DUCK MOON STAR BEAR WOLF LION PUMA HAWK CROW SEAL CRAB TUNA KIWI LIME PLUM PEAR CORN BEAN ' +
  'RICE SOUP TACO CAKE PIES MINT SAGE ROSE LILY FERN MOSS TREE LEAF ROCK SAND DUNE HILL LAKE POND WAVE ' +
  'TIDE REEF SNOW HAIL RAIN MIST WIND GUST FIRE LAVA COAL GOLD RUBY JADE IRON ZINC TOYS KITE BALL BELL ' +
  'DRUM HORN HARP FLUTE SOCK BOOT HATS CAPE MASK RING GEMS COIN BOAT SHIP SAIL OARS RAFT JEEP BIKE VANS ' +
  'TRAM BUSY ZOOM JUMP SKIP HOPS FLIP SPIN TWIRL BONK BOOM ZAPS POPS FIZZ BUZZ HUMS PURR MEOW WOOF HONK ' +
  'YETI OGRE ELFS GNOME DODO EMUS YAKS GNUS NEWT TOAD MOTH WASP BEES ANTS SLUG SNAIL CLAM SQUID KOIS COOK ' +
  'CHEF NOOB PROS ACES KING DUKE KNAVE SAGA EPIC TALE MYTH LORE QUIZ GAME PLAY TEAM CLUB GANG CREW BAND'
)
  .split(/\s+/)
  .filter((w) => /^[A-Z]{4}$/.test(w));

/** A code not in `taken`: a free word if there is one, else 4 random letters. */
export function newRoomCode(taken: (code: string) => boolean, rand: () => number = Math.random): string {
  const free = WORDS.filter((w) => !taken(w));
  if (free.length) return free[Math.floor(rand() * free.length)];
  for (;;) {
    const code = Array.from({ length: 4 }, () => String.fromCharCode(65 + Math.floor(rand() * 26))).join('');
    if (!taken(code)) return code;
  }
}
