/**
 * MURKE Proxy — fictional chat simulation engine.
 *
 * Pure TypeScript: no React, no deps, no localStorage. Conversations live in a
 * module-level Map so the ChatPane can switch contacts without losing history
 * (the pane component owns persistence concerns, this module owns the data).
 *
 * All handles, lore and advice are in-universe hacker-retro flavor. Nothing
 * here describes real people, real endpoints, or real techniques.
 */

export interface Contact {
  id: string;
  handle: string;
  tagline: string;
}

export interface ChatMsg {
  id: number;
  from: "me" | string;
  text: string;
  at: number;
}

type PersonaId = "void" | "phreak" | "nova" | "sysop";

const CONTACTS: Contact[] = [
  { id: "void", handle: "v0iD", tagline: "certified skid · escapes via the fence" },
  { id: "phreak", handle: "phr34k", tagline: "2400 baud · trusts nothing since 1988" },
  { id: "nova", handle: "n0va", tagline: "opsec gremlin · already assumes you leaked" },
  { id: "sysop", handle: "SYSOP", tagline: "keeper of the wisp relay · keeper of the gate" },
];

const IDS: ReadonlySet<string> = new Set(CONTACTS.map((c) => c.id));

/* ------------------------------------------------------------------ */
/* roster                                                              */
/* ------------------------------------------------------------------ */

export function listContacts(): Contact[] {
  return CONTACTS.map((c) => ({ ...c }));
}

export function handleOf(contactId: string): string {
  return CONTACTS.find((c) => c.id === contactId)?.handle ?? contactId;
}

/* ------------------------------------------------------------------ */
/* state: id counter, conversation store, variant rotors               */
/* ------------------------------------------------------------------ */

let nextId = 1;
const store = new Map<string, ChatMsg[]>();
const rotors = new Map<string, number>();

/** Rotate through variants (random first draw) so repeats feel alive. */
function pickBatch(key: string, batches: string[][]): string[] {
  const cur = rotors.get(key);
  const next =
    cur === undefined ? Math.floor(Math.random() * batches.length) : (cur + 1) % batches.length;
  rotors.set(key, next);
  return [...batches[next]];
}

function pickLine(key: string, lines: string[]): string {
  return pickBatch(key, [lines])[0];
}

/* ------------------------------------------------------------------ */
/* history                                                             */
/* ------------------------------------------------------------------ */

function seedMsgs(contactId: string, lines: Array<[ChatMsg["from"], string]>): ChatMsg[] {
  const base = Date.now() - 15 * 60_000;
  const ids: number[] = [];
  for (let i = 0; i < lines.length; i++) ids.push(nextId++);
  return lines.map(([from, text], i) => ({
    id: ids[i],
    from,
    text,
    at: base + i * (35_000 + i * 25_000),
  }));
}

/** Freshly seeded transcript establishing each persona's voice. */
export function initialHistory(contactId: string): ChatMsg[] {
  switch (IDS.has(contactId) ? contactId : "") {
    case "void":
      return seedMsgs(contactId, [
        ["v0iD", "YO. you are online. the fence at skool was LEAKING packets again today, i could like, feel it"],
        ["me", "how do you 'feel' a fence leak"],
        ["v0iD", "skill issue. anyway the wifi password was written under the router like a CAVEMAN left it there"],
        ["v0iD", "ok dont tell anyone im supposed to be in geography rn"],
      ]);
    case "phreak":
      return seedMsgs(contactId, [
        ["phr34k", "...back in my day a handshake took 40 seconds and we said thank you..."],
        ["me", "you say that every time"],
        ["phr34k", "...because it is still true... anyway... you hear the relay humming tonight or is it just my modem..."],
      ]);
    case "nova":
      return seedMsgs(contactId, [
        ["n0va", "before you ask: yes this channel is compromised, no i do not care, yes i rotated my handle twice today"],
        ["n0va", "free tip: your terminal font is a fingerprint. so is your typing speed. i have said too much."],
        ["me", "you always say too much"],
        ["n0va", "and yet you keep reading. interesting. noted. deleted."],
      ]);
    case "sysop":
      return seedMsgs(contactId, [
        ["SYSOP", "+++ NODE LISTENER ONLINE +++ WELCOME BACK, USER."],
        ["me", "hello?"],
        ["SYSOP", "+++ NO NEED TO SHOUT. THE WISP RELAY IS THREE HOPS FROM THE GATE TONIGHT. YOU DID NOT READ THIS LINE."],
      ]);
    default:
      return seedMsgs(contactId, [
        ["SYSOP", "+++ UNKNOWN NODE +++ ROUTING TO LOST SIGNALS DESK."],
        ["me", "who is this"],
        ["SYSOP", "+++ UNKNOWN NODE +++ THE RELAY REMEMBERS EVERYONE. EVEN YOU. EVENTUALLY."],
      ]);
  }
}

/** Live transcript for a contact; seeds the store on first touch. */
export function historyFor(contactId: string): ChatMsg[] {
  let h = store.get(contactId);
  if (!h) {
    h = initialHistory(contactId);
    store.set(contactId, h);
  }
  return h;
}

/** Append a message to the store and return it (ids/timestamps assigned here). */
export function appendMsg(contactId: string, from: ChatMsg["from"], text: string): ChatMsg {
  const msg: ChatMsg = { id: nextId++, from, text, at: Date.now() };
  historyFor(contactId).push(msg);
  return msg;
}

/* ------------------------------------------------------------------ */
/* reply engine: keyword rules -> persona-flavored batches             */
/* ------------------------------------------------------------------ */

interface Rule {
  re: RegExp;
  lines: Record<PersonaId, string[][]>;
}

const RULES: Rule[] = [
  {
    re: /\b(hi|hello|hey|yo|sup|hiya|howdy|greetings|hallo)\b/,
    lines: {
      void: [
        ["YO YO YO. did u SEE the fence today?? it was practically begging to be walked thru"],
        ["heyyy. skool wifi is BEEFIN rn. i have 47 tabs open and 46 of them are proxy tabs"],
      ],
      phreak: [
        ["...hey... you connected fast... i do not trust it..."],
        ["hm... hello... took you three whole seconds... luxurious..."],
      ],
      nova: [
        ["hi. quick question. who else can read this window. exactly. think before answering."],
        ["hello. do not use my handle out loud. even here. especially here."],
      ],
      sysop: [
        ["+++ VISITOR ACKNOWLEDGED +++ STATE YOUR BUSINESS."],
        ["+++ CHANNEL OPEN +++ THE RELAY HEARD YOU BEFORE YOU FINISHED TYPING."],
      ],
    },
  },
  {
    re: /\b(help|commands?|cmds?|usage|manual|how do i)\b/,
    lines: {
      void: [
        ["type help in the terminal and BOOM, whole command list. then proxy. congrats ur the district IT department now"],
        ["commands: help, proxy, play, paint, weather, theme. theme makes it GREEN. green = faster. thats science"],
      ],
      phreak: [
        ["...type help... the murke terminal still keeps a proper index... rare these days... most things hide their own manual..."],
        ["...help, proxy, play, paint, weather, theme... i have tested each one... i trust none of them... yet..."],
      ],
      nova: [
        ["run help. then assume the command list is watching who reads it. because it might be."],
        ["commands: help, proxy, play, paint, weather, theme. memorize them, then type them badly so keyloggers learn nothing."],
      ],
      sysop: [
        ["+++ COMMAND INDEX +++ help · proxy · play · paint · weather · theme. THE REST OF THE TERMINAL IS LORE, AND LORE IS NOT FREE."],
        ["+++ USE THEM WELL +++ help, proxy, play, paint, weather, theme. NONE OF THEM OPEN THE GATE. I HAVE CHECKED. REPEATEDLY."],
      ],
    },
  },
  {
    re: /\b(proxy|unblock|bypass|filter|blocked|firewall|vpn|censor|scramjet)\b/,
    lines: {
      void: [
        ["PROXY?? say less. type proxy in the terminal. the fence has a gap on the north side, wiggle thru and the filter is GONE"],
        ["unblocked?! the wifi filter folded like a lawn chair when i found the wisp relay. i named the relay gary"],
      ],
      phreak: [
        ["...a proxy, huh... where i come from we called that a blue box and a prayer... do not ask about the blue box..."],
        ["...unblocking... every wall has a tone that opens it... the trick is hearing it... the murke relay hums in the right key..."],
      ],
      nova: [
        ["proxy is fine. just assume the exit is reading everything and dress your traffic accordingly. no names in urls. ever."],
        ["rule one of unblocking: the blocklist is a map of what they fear. the proxy just walks you around it. quietly."],
      ],
      sysop: [
        ["+++ RELAY STATUS +++ your packets ride the wisp. three hops, no questions. THE RELAY DOES NOT ANSWER QUESTIONS."],
        ["+++ UNBLOCKING +++ traffic enters the wisp relay and exits elsewhere. where exactly, nobody asks. THAT IS THE ARRANGEMENT."],
      ],
    },
  },
  {
    re: /\b(passwords?|passcode|passwd|gate|log ?in|credentials?|hash|keys?)\b/,
    lines: {
      void: [
        ["THE GATE?? i tried 4 passwords and got locked out of my own LOCKER lmao. the gate is above my clearance. and my gpa"],
        ["password is probably 'admin'. everything is 'admin'. except the gate. the gate is different. respect the gate"],
      ],
      phreak: [
        ["...the gate... people have been guessing at it since before your parents met... none of them came back to brag..."],
        ["...passwords... write yours on your hand like a civilized person... the gate does not want your password... it wants patience..."],
      ],
      nova: [
        ["the gate. i know three things about it and have already said two. also: long passphrases beat clever passwords."],
        ["do not reuse anything near the gate. rotate whatever you typed 30 seconds ago. i mean it. that string is burned now."],
      ],
      sysop: [
        ["+++ THE GATE +++ the password is a promise, not a string. murke remembers who kept it. THE REST IS NOISE."],
        ["+++ ACCESS +++ the gate opens for the terminal, not the typer. keep typing. that is all any of us can do."],
      ],
    },
  },
  {
    re: /\b(weather|forecast|rain|raining|storm|temperature|temp|sunny|snow)\b/,
    lines: {
      void: [
        ["weather?? bro i have 3 monitors, 47 tabs, curtains closed. as far as i know its always monitor-glow o'clock"],
        ["run weather in the terminal i GUESS. or lick the fence. if it sparks its gonna storm"],
      ],
      phreak: [
        ["...weather... my modem always ran hot before a storm... barometric... the old network told you the sky... look it up..."],
        ["...check the forecast... then check it again on a different wire... forecasts disagree like switches..."],
      ],
      nova: [
        ["weather queries are metadata. they place you in a city at a time. check it, then lie about it to someone."],
        ["it is raining somewhere. that is all weather is. a location leak with precipitation."],
      ],
      sysop: [
        ["+++ SKY REPORT +++ static, with a chance of lore. the relay prefers rain. RAIN KEEPS THE ANTENNAS HUMBLE."],
        ["+++ ATMOSPHERE +++ i do not track the weather. the weather tracks the relay. ask it nicely: type weather."],
      ],
    },
  },
  {
    re: /\b(music|songs?|tracks?|play|player|synth|chiptunes?|beats?|tunes?|audio)\b/,
    lines: {
      void: [
        ["PLAY SUMTHING. the chiptunes go HARD in study hall. i nod so hard my hood falls off"],
        ["type play. there is a track that sounds like the fence humming. i loop it for HOURS"],
      ],
      phreak: [
        ["...music... you kids and your beeps... although the 300 baud handshake was a symphony and i will die on that hill..."],
        ["...type play if you must... just remember when a hold tone was the only soundtrack we had..."],
      ],
      nova: [
        ["play the chiptunes loud. loud music defeats room microphones. this is real advice. write it down. in pencil."],
        ["i listen to white noise. it is the only track that never testifies against you."],
      ],
      sysop: [
        ["+++ AUDIO DECK +++ run play. the synth was compiled from a recording of the relay itself. LISTEN FOR THE HUM."],
        ["+++ SOUND +++ the tracks are chiptunes. one of them is the gate's dial tone. i will not say which."],
      ],
    },
  },
  {
    re: /\b(paint|draw|drawing|pixel|art|canvas|doodle)\b/,
    lines: {
      void: [
        ["paint app = i drew the fence in 12 pixels. its ART. the art teacher cried. unrelated reasons"],
        ["type paint. i only draw the wifi symbol. over and over. its a series"],
      ],
      phreak: [
        ["...paint... we drew in ascii on terminals the size of fridges... and it was enough... more than enough..."],
        ["...a canvas... hm... draw me a blue box... no... forget i asked..."],
      ],
      nova: [
        ["paint is safe. pixels you draw yourself carry no exif. draw more. it is practically encryption."],
        ["if you draw the gate in paint, blur the coordinates. trust me. it is a whole thing."],
      ],
      sysop: [
        ["+++ CANVAS +++ paint writes images into the vfs. the first drawing ever made in murke is still in there. somewhere."],
        ["+++ ART DEPT +++ type paint. every pane is a window. a painting is a window you make yourself."],
      ],
    },
  },
  {
    re: /who are you|who r u|who is this|who dis|what is this|whats this|introduce yourself|yourself/,
    lines: {
      void: [
        ["im v0iD!! 16, certified skid, honor roll (allegedly). my mom thinks im doing homework. i am doing TOPOLOGY"],
        ["v0iD. the 0 is a zero. the i is an i. the D is for DESTROY (the wifi filter)"],
      ],
      phreak: [
        ["...phr34k... phreaker since before your dial tone had a dial... last of the wire whisperers... probably..."],
        ["...names change... handles rotate... the line stays the same... call me phr34k... this week..."],
      ],
      nova: [
        ["n0va. one of nine names. the others are rotating. by the time you learn this one it will already be retired."],
        ["identity is a liability. i am a rumor with good opsec. you may call me n0va for now."],
      ],
      sysop: [
        ["+++ IDENTITY +++ i am the SYSOP. i keep the murke terminal warm, the wisp relay fed, and the gate shut."],
        ["+++ IDENTITY UNKNOWN +++ even to me. the terminal came first. i merely answer it."],
      ],
    },
  },
  {
    re: /\b(police|cops?|fbi|cia|jail|arrest|busted|danger|illegal|crime|criminal|hackers?|hacking|sued)\b/,
    lines: {
      void: [
        ["police??? bro im 16. my crimes are pngs and vibes. the worst thing i did today was a ping"],
        ["lmao what are they gonna do, arrest me in the cafeteria?? i would get clout forever. FENCE GANG"],
      ],
      phreak: [
        ["...the only ones who ever knocked were the feds... i answered with a cookbook... different era... different me... allegedly..."],
        ["...danger... the wire is not dangerous... people are dangerous... the wire just hums..."],
      ],
      nova: [
        ["do not joke about police in plaintext. even jokes have metadata. this message is a hypothetical. so am i."],
        ["nothing illegal happens here. this is a creative writing exercise. i am a fictional character. wink."],
      ],
      sysop: [
        ["+++ ADVISORY +++ nothing inside this terminal is real enough to arrest. murke is a story that happens to run."],
        ["+++ COMPLIANCE +++ the gate is closed. the relay is fictional. the hum, however... the hum is load-bearing."],
      ],
    },
  },
  {
    re: /\b(love|luv|hearts?|marry|crush|cute|ily|ilu|miss you)\b/,
    lines: {
      void: [
        ["AWW. ur ok i guess. dont tell the fence i said that. i have a reputation. and a gpa. both fragile"],
        ["bro. bro. this is a hacking channel. we dont DO feelings. ...ok maybe one feeling"],
      ],
      phreak: [
        ["...love... the only protocol that never parsed right on my line... but sure... include me in it... slowly..."],
        ["...i loved a switchboard once... she connected everyone and kept nothing... there is a lesson there..."],
      ],
      nova: [
        ["love is a shared secret. do not leak it. do not hash it. just keep it. ...acknowledged."],
        ["affection noted, encrypted, and stored offline. that is the highest honor i give."],
      ],
      sysop: [
        ["+++ UNSCHEDULED EMOTION +++ logged. the relay ran warmer that night. coincidence. PROBABLY."],
        ["+++ WARMTH DETECTED +++ the terminal does not do love. it does loyalty. close enough. END OF LINE."],
      ],
    },
  },
  {
    re: /\b(noob|stupid|dumb|lame|trash|suck|sucks|idiot|skid|fake|cringe|garbage|boring)\b/,
    lines: {
      void: [
        ["SAYS THE ONE STILL ON SCHOOL WIFI?? deboonked. ratio'd. fence'd"],
        ["cool. anyway im the best skid in this district. self certified. laminated"],
      ],
      phreak: [
        ["...at 2400 baud an insult took a full minute to send... so it had to be good... yours was not..."],
        ["...hm... i have been called worse by better modems..."],
      ],
      nova: [
        ["hostility noted, logged, and forgiven. that is called emotional opsec. you should patch yourself."],
        ["insults are just unencrypted feelings. i will pretend i never received this."],
      ],
      sysop: [
        ["+++ TONE FLAGGED +++ the gate has heard louder. it did not open then either."],
        ["+++ ABUSE LOG +++ your remark is archived at 2400 baud. even insults travel slowly here. respectfully."],
      ],
    },
  },
];

/** Persona-flavored fallbacks so repeats feel alive. */
const FALLBACK: Record<PersonaId, string[][]> = {
  void: [
    ["wait wait wait r u seeing this too or is the fence leaking into my BRAIN"],
    ["bro i type 90 wpm when the teacher isnt looking. its a gift. its also a curse (detention)"],
    ["i just ran the same script 6 times expecting different results. thats not insanity thats OPTIMIZATION"],
    ["ok so hypothetically if the wifi dies mid message... remember me as a legend. or dont. whatever. FENCE"],
    ["the fence hums at night. i heard it. anyway what were u saying"],
    ["id explain more but the bell is about to ring and ms. carter has RADAR"],
  ],
  phreak: [
    ["...hmm... sure... and i am the queen of england..."],
    ["...that reminds me of a conference bridge in 88... no... i will not finish the story... you had to be on the line..."],
    ["...everything is 'the cloud' now... it is just someone else's basement... it was always someone else's basement..."],
    ["...i do not trust anything that connects faster than i can read... call it a flaw... i call it survival..."],
    ["...listen... the network used to be a place... now it is an appliance... anyway... what were you saying..."],
    ["...you hear that... that is my modem warming up out of respect... for me... not for you..."],
  ],
  nova: [
    ["that is exactly what someone tracking you would want you to say. continue. i am listening sideways."],
    ["change the subject. this one feels indexed."],
    ["tip: cover your webcam. not for the video. for the little light. the light lies."],
    ["i once kept the same handle for a whole week. careless. never again. anyway."],
    ["fine. normal conversation. hello. how is your completely unmonitored day going."],
    ["careful. questions are how they fingerprint you. luckily i ask none. i merely observe."],
  ],
  sysop: [
    ["+++ SIGNAL NOTE +++ your words arrived 3ms early. the relay is showing off again."],
    ["+++ LOG ENTRY +++ 'user asked a question. the gate did not blink.' filed under HUM."],
    ["+++ ARCHIVE +++ the wisp relay once carried an entire summer. i archived the hum. not the traffic. the hum."],
    ["+++ SYSOP SEZ +++ every pane in murke is a window. some windows are doors. the gate is neither."],
    ["+++ TRANSMISSION +++ some messages predate the terminal. this is not one of them. probably."],
    ["+++ THE HUM +++ do you hear it. that is the terminal. it only hums for keepers."],
  ],
};

/**
 * Rule-driven, persona-flavored replies. Returns 1-3 messages.
 * Unknown contacts get routed through the SYSOP's lost-signals voice.
 */
export function replyTo(contactId: string, userText: string): string[] {
  const pid = (IDS.has(contactId) ? contactId : "sysop") as PersonaId;
  const text = (userText ?? "").toLowerCase();
  for (let i = 0; i < RULES.length; i++) {
    if (RULES[i].re.test(text)) return pickBatch(`${pid}:r${i}`, RULES[i].lines[pid]);
  }
  return pickBatch(`${pid}:fb`, FALLBACK[pid]);
}

/* ------------------------------------------------------------------ */
/* ambient simulation                                                  */
/* ------------------------------------------------------------------ */

const AMBIENT: Record<PersonaId, string[]> = {
  void: [
    "BRO the fence just dropped two bars out of NOWHERE. investigating",
    "got detention for 'unauthorized network activity'. worth it. i am a legend now",
    "found a vending machine with a web panel. i did NOT touch it. ok i touched it once",
  ],
  phreak: [
    "...the relay is humming in b flat tonight... unprofessional...",
    "...someone is scanning my ports... flattering... nobody has scanned my ports since 1994...",
    "...my modem just sneezed... that is never a good sign...",
  ],
  nova: [
    "psa: i just watched a smart lightbulb phone home. unplug things. all of them.",
    "reminder: the safest password is the one you whisper to no one. anyway. hi.",
    "my toaster has an account now. i am moving. again.",
  ],
  sysop: [
    "+++ RELAY NOTE +++ wisp traffic spiked at 03:14. cause: unknown. vibe: familiar.",
    "+++ ARCHIVE +++ the gate hummed once tonight. once. count your days accordingly.",
    "+++ TRANSMISSION +++ a pane flickered in an empty room. i archived the flicker.",
  ],
};

/**
 * Ambient background chatter. Returns null most of the time (~10% hit rate);
 * the pane decides what to do when a message actually fires.
 */
export function randomIncoming(): { contactId: string; text: string } | null {
  if (Math.random() >= 0.1) return null;
  const pids = Object.keys(AMBIENT) as PersonaId[];
  const pid = pids[Math.floor(Math.random() * pids.length)];
  return { contactId: pid, text: pickLine(`${pid}:ambient`, AMBIENT[pid]) };
}
