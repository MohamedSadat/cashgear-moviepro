// Writes the built-in project templates (assets/templates/*.json). A template is
// tracks of timed clips: numbered slots the user's media fills, titles from the
// title templates (assets/titles), generated backgrounds, stickers and sounds from
// the app's pack, and adjustment layers, with transitions between touching clips
// (`from` and `to` index a track's clips; null is a free edge). Times are seconds. Run it after changing a design here; the JSON files are committed
// and read by the app, which bundles them.
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './lib.mjs';

const out = join(root, 'assets/templates');

const rgb = (hex, a = 1) => ({
  r: Math.round((parseInt(hex.slice(1, 3), 16) / 255) * 1e4) / 1e4,
  g: Math.round((parseInt(hex.slice(3, 5), 16) / 255) * 1e4) / 1e4,
  b: Math.round((parseInt(hex.slice(5, 7), 16) / 255) * 1e4) / 1e4,
  a,
});

const effect = (kind, params = {}) => ({ kind, params });
const title = (template, at, seconds, texts, properties) => ({
  type: 'title',
  template,
  at,
  seconds,
  ...(texts ? { texts } : {}),
  ...(properties ? { properties } : {}),
});
const sticker = (id, at, seconds, properties) => ({
  type: 'sticker',
  sticker: id,
  at,
  seconds,
  ...(properties ? { properties } : {}),
});
const sound = (id, at, seconds, extra = {}) => ({
  type: 'sound',
  sound: id,
  at,
  seconds,
  ...extra,
});
const adjust = (at, seconds, effects) => ({ type: 'adjustment', at, seconds, effects });
const background = (hex, at, seconds) => ({ type: 'background', color: rgb(hex), at, seconds });
const place = (x, y, scale, extra = {}) => ({
  transform: { x, y, scaleX: scale, scaleY: scale, ...extra },
});

/**
 * Slots one after another from `at`: `lengths` in seconds, motions taken in turn,
 * numbered from `first`. Transitions of `kind` join them.
 */
function run(lengths, options = {}) {
  const { at = 0, first = 1, motions = [], transition, effects } = options;
  let time = at;
  const clips = lengths.map((seconds, i) => {
    const clip = {
      type: 'slot',
      slot: first + i,
      at: time,
      seconds,
      ...(motions.length ? { motion: motions[i % motions.length] } : {}),
      ...(effects ? { effects } : {}),
    };
    time += seconds;
    return clip;
  });
  const transitions = transition
    ? lengths.slice(1).map((_, i) => ({ from: i, to: i + 1, ...transition }))
    : [];
  return { clips, transitions, end: time };
}

const kenBurns = ['zoomIn', 'panLeft', 'zoomOut', 'panRight'];

const all = [];
function template(id, body) {
  all.push({
    id,
    body: { pack: 'builtin', version: 1, ...body },
  });
}

// ---- Slideshows ----

{
  const lengths = [3, 3, 3, 3, 3, 3];
  const slots = run(lengths, {
    motions: kenBurns,
    transition: { kind: 'cross-dissolve', seconds: 0.6 },
  });
  template('travel-slideshow', {
    name: 'Travel slideshow',
    category: 'Slideshows',
    kind: 'project',
    aspect: 'landscape',
    description:
      'Six photos or clips drifting in slow zooms and pans, with a title and an acoustic bed.',
    tracks: [
      { name: 'Clips', clips: slots.clips, transitions: slots.transitions },
      { name: 'Look', clips: [adjust(0, slots.end, [effect('vignette', { amount: 0.4 })])] },
      { name: 'Titles', clips: [title('elegant', 0.4, 3, ['My Journey'])] },
      {
        name: 'Music',
        role: 'music',
        clips: [sound('acoustic-morning', 0, slots.end, { fadeOut: 2 })],
      },
    ],
  });
}
{
  const lengths = [2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5];
  const slots = run(lengths, {
    motions: ['zoomIn', 'zoomOut'],
    transition: { kind: 'dip', seconds: 0.5, params: { color: rgb('#ffffff') } },
  });
  template('photo-memories', {
    name: 'Photo memories',
    category: 'Slideshows',
    kind: 'project',
    aspect: 'landscape',
    description: 'Eight memories, dipping through white, in the look of old film.',
    tracks: [
      { name: 'Photos', clips: slots.clips, transitions: slots.transitions },
      {
        name: 'Look',
        clips: [
          adjust(0, slots.end, [
            effect('old-film', { sepia: 0.35, grain: 0.2, scratches: 0.2, flicker: 0.1 }),
          ]),
        ],
      },
      { name: 'Titles', clips: [title('handwritten', 0.3, 2.2, ['Our memories'])] },
      {
        name: 'Music',
        role: 'music',
        clips: [sound('lofi-evening', 0, slots.end, { fadeOut: 2 })],
      },
    ],
  });
}
{
  const lengths = [3.5, 3.5, 3.5, 3.5, 3.5, 3.5];
  const slots = run(lengths, {
    motions: ['zoomIn', 'panRight', 'zoomOut'],
    transition: { kind: 'blur-dissolve', seconds: 0.8 },
  });
  template('wedding-day', {
    name: 'Wedding day',
    category: 'Slideshows',
    kind: 'project',
    aspect: 'landscape',
    description: 'Six soft, warm moments joined by blurred dissolves, under an elegant title.',
    tracks: [
      { name: 'Clips', clips: slots.clips, transitions: slots.transitions },
      {
        name: 'Look',
        clips: [
          adjust(0, slots.end, [
            effect('temperature-tint', { temperature: 0.25 }),
            effect('vignette', { amount: 0.3, softness: 0.7 }),
          ]),
        ],
      },
      { name: 'Titles', clips: [title('elegant', 0.5, 3.5, ['Forever Begins'])] },
      {
        name: 'Music',
        role: 'music',
        clips: [sound('ambient-drift', 0, slots.end, { fadeOut: 3 })],
      },
    ],
  });
}

// ---- Vlog ----

{
  const lengths = [1.2, 1.2, 1.2, 1.2, 3.2];
  const slots = run(lengths, {
    transition: { kind: 'push', seconds: 0.3, params: { direction: 'left' } },
  });
  template('vlog-opener', {
    name: 'Vlog opener',
    category: 'Vlog',
    kind: 'project',
    aspect: 'landscape',
    description: 'Four quick cuts that push into a fifth shot with a bold title.',
    tracks: [
      { name: 'Clips', clips: slots.clips, transitions: slots.transitions },
      { name: 'Titles', clips: [title('statement', 4.9, 2.8, ["Let's go!"])] },
      {
        name: 'Sounds',
        clips: [1.05, 2.25, 3.45, 4.65].map((at) => sound('swoosh', at, 0.45)),
      },
      {
        name: 'Music',
        role: 'music',
        clips: [sound('boom-bap', 0, slots.end, { fadeOut: 1 })],
      },
    ],
  });
}
{
  const lengths = [2.5, 2.5, 2.5, 2.5, 2.5, 2.5];
  const slots = run(lengths, {
    transition: { kind: 'wipe', seconds: 0.4, params: { direction: 'right', softness: 0.1 } },
  });
  const notes = [
    ['7:00 AM', 'Morning coffee'],
    ['9:30 AM', 'Off to work'],
    ['1:00 PM', 'Lunch break'],
    ['6:00 PM', 'Golden hour'],
  ];
  template('day-in-my-life', {
    name: 'Day in my life',
    category: 'Vlog',
    kind: 'project',
    aspect: 'landscape',
    description: 'Six moments of a day, each with a time stamp lower third.',
    tracks: [
      { name: 'Clips', clips: slots.clips, transitions: slots.transitions },
      {
        name: 'Titles',
        clips: notes.map((texts, i) => title('lower-minimal', i * 2.5 + 0.4, 2, texts)),
      },
      {
        name: 'Music',
        role: 'music',
        clips: [sound('happy-ukulele', 0, slots.end, { fadeOut: 1.5 })],
      },
    ],
  });
}

// ---- Promo ----

{
  const lengths = [3, 3, 3];
  const slots = run(lengths, {
    motions: ['zoomIn'],
    transition: { kind: 'zoom', seconds: 0.5, params: { mode: 'in' } },
  });
  template('product-promo', {
    name: 'Product promo',
    category: 'Promo',
    kind: 'project',
    aspect: 'landscape',
    description: 'Three product shots zooming into each other, a headline and a call to action.',
    tracks: [
      { name: 'Clips', clips: slots.clips, transitions: slots.transitions },
      {
        name: 'Titles',
        clips: [
          title('statement', 0.3, 2.5, ['New Collection']),
          title('lower-boxes', 6.2, 2.6, ['Shop now', 'LIMITED TIME']),
        ],
      },
      { name: 'Stickers', clips: [sticker('new', 3.2, 2.5, place(620, -300, 0.3))] },
      {
        name: 'Music',
        role: 'music',
        clips: [sound('corporate-bright', 0, slots.end, { fadeOut: 1 })],
      },
    ],
  });
}
{
  const slots = run([2.5, 2.5, 2.5], {
    at: 1.5,
    transition: { kind: 'slide', seconds: 0.4, params: { direction: 'left' } },
  });
  template('sale-announcement', {
    name: 'Sale announcement',
    category: 'Promo',
    kind: 'project',
    aspect: 'landscape',
    description: 'A big sale headline on red, then three products with sale badges.',
    tracks: [
      {
        name: 'Clips',
        clips: [background('#c81e3a', 0, 1.5), ...slots.clips],
        transitions: [
          { from: 0, to: 1, kind: 'push', seconds: 0.4, params: { direction: 'up' } },
          ...slots.transitions.map((t) => ({ ...t, from: t.from + 1, to: t.to + 1 })),
        ],
      },
      { name: 'Titles', clips: [title('breaking', 0.1, 1.6, ['BIG SALE'])] },
      {
        name: 'Stickers',
        clips: [
          sticker('sale', 1.8, 2.2, place(-620, -280, 0.35)),
          sticker('burst', 4.3, 2.2, place(620, 280, 0.35)),
        ],
      },
      { name: 'Sounds', clips: [sound('impact', 0, 2)] },
      {
        name: 'Music',
        role: 'music',
        clips: [sound('electro-pulse', 0, slots.end, { fadeOut: 1 })],
      },
    ],
  });
}
{
  const lengths = [2, 2, 2, 2, 2];
  const slots = run(lengths, {
    motions: kenBurns,
    transition: { kind: 'luma-wipe', seconds: 0.5, params: { gradient: 'clock' } },
  });
  template('event-recap', {
    name: 'Event recap',
    category: 'Promo',
    kind: 'project',
    aspect: 'landscape',
    description: 'Five highlights wiping round like a clock, under a title and subtitle.',
    tracks: [
      { name: 'Clips', clips: slots.clips, transitions: slots.transitions },
      {
        name: 'Titles',
        clips: [title('title-and-subtitle', 0.2, 2.6, ['Event Recap', 'The highlights'])],
      },
      {
        name: 'Music',
        role: 'music',
        clips: [sound('cinematic-rise', 0, slots.end, { fadeOut: 1.5 })],
      },
    ],
  });
}

// ---- Social ----

{
  const lengths = [4, 4, 4];
  const slots = run(lengths, {
    motions: ['zoomIn', 'zoomOut'],
    transition: { kind: 'slide', seconds: 0.4, params: { direction: 'up' } },
  });
  template('vertical-story', {
    name: 'Story',
    category: 'Social',
    kind: 'project',
    aspect: 'portrait',
    description: 'A 9:16 story of three shots sliding up, with stickers and a call-out.',
    tracks: [
      { name: 'Clips', clips: slots.clips, transitions: slots.transitions },
      {
        name: 'Stickers',
        clips: [
          sticker('heart-eyes', 0.6, 3, place(0, -560, 0.45)),
          sticker('sparkles', 4.4, 3, place(0, 520, 0.45)),
        ],
      },
      { name: 'Titles', clips: [title('callout', 8.5, 3.3, ['Swipe up'])] },
      {
        name: 'Music',
        role: 'music',
        clips: [sound('sunny-steps', 0, slots.end, { fadeOut: 1 })],
      },
    ],
  });
}
{
  const lengths = [1, 1, 1, 1, 1, 1];
  const slots = run(lengths, {
    transition: { kind: 'zoom', seconds: 0.2, params: { mode: 'in' } },
  });
  template('vertical-trend', {
    name: 'Trend',
    category: 'Social',
    kind: 'project',
    aspect: 'portrait',
    description: 'Six one-second cuts for a 9:16 trend, with glitches on the beats.',
    tracks: [
      { name: 'Clips', clips: slots.clips, transitions: slots.transitions },
      {
        name: 'Glitches',
        clips: [1, 3, 5].map((at) => adjust(at - 0.1, 0.3, [effect('glitch', { amount: 0.8 })])),
      },
      { name: 'Titles', clips: [title('neon', 0, 1.8, ['TRENDING'])] },
      {
        name: 'Sounds',
        clips: [1, 3, 5].map((at) => sound('glitch', at - 0.1, 0.6)),
      },
      {
        name: 'Music',
        role: 'music',
        clips: [sound('electro-pulse', 0, slots.end, { fadeOut: 0.5 })],
      },
    ],
  });
}
{
  const lengths = [2.5, 2.5, 2.5, 2.5];
  const slots = run(lengths, {
    motions: ['zoomIn'],
    transition: { kind: 'cross-dissolve', seconds: 0.4 },
  });
  template('square-highlights', {
    name: 'Square highlights',
    category: 'Social',
    kind: 'project',
    aspect: 'square',
    description: 'Four 1:1 highlights for a feed, ending on your handle.',
    tracks: [
      { name: 'Clips', clips: slots.clips, transitions: slots.transitions },
      { name: 'Stickers', clips: [sticker('fire', 0.4, 2, place(360, -360, 0.35))] },
      { name: 'Titles', clips: [title('follow', 7.6, 2.4, ['@yourhandle'])] },
      {
        name: 'Music',
        role: 'music',
        clips: [sound('boom-bap', 0, slots.end, { fadeOut: 1 })],
      },
    ],
  });
}
{
  // Before on the left half, after on the right, then the result full frame.
  const half = (left) => ({
    transform: { x: left ? -480 : 480, y: 0, scaleX: 1, scaleY: 1 },
    crop: { left: 0.25, right: 0.25, top: 0, bottom: 0 },
  });
  template('before-after', {
    name: 'Before and after',
    category: 'Social',
    kind: 'project',
    aspect: 'landscape',
    description: 'A split screen of before and after, then the after on its own.',
    tracks: [
      {
        name: 'Before',
        clips: [
          { type: 'slot', slot: 1, at: 0, seconds: 5, properties: half(true) },
          { type: 'slot', slot: 3, at: 5, seconds: 4, motion: 'zoomIn' },
        ],
        transitions: [
          { from: 0, to: 1, kind: 'wipe', seconds: 0.6, params: { direction: 'left' } },
        ],
      },
      {
        name: 'After',
        clips: [{ type: 'slot', slot: 2, at: 0, seconds: 5, properties: half(false) }],
      },
      {
        name: 'Before label',
        clips: [title('default', 0.3, 4.2, ['Before'], place(-480, 380, 0.6))],
      },
      {
        name: 'After label',
        clips: [title('default', 0.3, 4.2, ['After'], place(480, 380, 0.6))],
      },
      {
        name: 'Music',
        role: 'music',
        clips: [sound('corporate-bright', 0, 9, { fadeOut: 1 })],
      },
    ],
  });
}

// ---- Arabic ----

{
  const lengths = [3, 3, 3, 3];
  const slots = run(lengths, {
    motions: ['zoomIn', 'panLeft'],
    transition: { kind: 'luma-wipe', seconds: 0.6, params: { gradient: 'iris' } },
  });
  template('ramadan-greetings', {
    name: 'Ramadan greetings',
    category: 'Arabic',
    kind: 'project',
    aspect: 'landscape',
    description: 'Four warm shots opening like an iris, with a Ramadan greeting.',
    tracks: [
      { name: 'Clips', clips: slots.clips, transitions: slots.transitions },
      {
        name: 'Look',
        clips: [adjust(0, slots.end, [effect('temperature-tint', { temperature: 0.2 })])],
      },
      { name: 'Titles', clips: [title('arabic-ramadan', 0.4, 4)] },
      {
        name: 'Stickers',
        clips: [
          sticker('star', 0.6, 3.6, place(-640, -300, 0.3)),
          sticker('sparkles', 6.4, 3.6, place(640, -300, 0.3)),
        ],
      },
      {
        name: 'Music',
        role: 'music',
        clips: [sound('ambient-drift', 0, slots.end, { fadeOut: 2 })],
      },
    ],
  });
}
{
  const lengths = [3, 3, 3, 3];
  const slots = run(lengths, {
    motions: ['zoomOut'],
    transition: { kind: 'spin', seconds: 0.5, params: { direction: 'clockwise' } },
  });
  template('eid-celebration', {
    name: 'Eid celebration',
    category: 'Arabic',
    kind: 'project',
    aspect: 'landscape',
    description: 'Four joyful moments spinning into each other, with an Eid greeting.',
    tracks: [
      { name: 'Clips', clips: slots.clips, transitions: slots.transitions },
      { name: 'Titles', clips: [title('arabic-welcome', 0.3, 3.5, ['عيد مبارك'])] },
      { name: 'Stickers', clips: [sticker('party', 6.2, 3, place(560, 260, 0.35))] },
      {
        name: 'Music',
        role: 'music',
        clips: [sound('happy-ukulele', 0, slots.end, { fadeOut: 1.5 })],
      },
    ],
  });
}
{
  const lengths = [3, 3, 3];
  const slots = run(lengths, {
    motions: ['zoomIn'],
    transition: { kind: 'push', seconds: 0.4, params: { direction: 'right' } },
  });
  template('bilingual-promo', {
    name: 'Bilingual promo',
    category: 'Arabic',
    kind: 'project',
    aspect: 'landscape',
    description: 'An offer in Arabic and a name in Arabic and English over three shots.',
    tracks: [
      { name: 'Clips', clips: slots.clips, transitions: slots.transitions },
      {
        name: 'Titles',
        clips: [title('arabic-offer', 0.3, 2.6), title('lower-bilingual', 3.4, 5.2)],
      },
      {
        name: 'Music',
        role: 'music',
        clips: [sound('corporate-bright', 0, slots.end, { fadeOut: 1 })],
      },
    ],
  });
}

// ---- Intros and outros ----

template('bold-intro', {
  name: 'Bold intro',
  category: 'Intros',
  kind: 'intro',
  description: 'Your shot behind a neon channel name, on a riser and an impact.',
  tracks: [
    {
      name: 'Clip',
      clips: [
        {
          type: 'slot',
          slot: 1,
          at: 0,
          seconds: 4,
          motion: 'zoomIn',
          effects: [effect('exposure', { stops: -1 }), effect('vignette', { amount: 0.6 })],
        },
      ],
    },
    { name: 'Titles', clips: [title('neon', 0.6, 3.4, ['YOUR CHANNEL'])] },
    { name: 'Riser', clips: [sound('riser', 0, 1.2)] },
    { name: 'Impact', clips: [sound('impact', 0.6, 2.5)] },
  ],
});
template('logo-reveal', {
  name: 'Logo reveal',
  category: 'Intros',
  kind: 'intro',
  description: 'Your logo or photo opening on black, presenting what follows.',
  tracks: [
    { name: 'Background', clips: [background('#05070b', 0, 3.5)] },
    {
      name: 'Logo',
      clips: [{ type: 'slot', slot: 1, at: 0.3, seconds: 3.2, properties: place(0, -60, 0.45) }],
      // Opening at its free start edge.
      transitions: [
        { from: null, to: 0, kind: 'luma-wipe', seconds: 1, params: { gradient: 'iris' } },
      ],
    },
    { name: 'Titles', clips: [title('elegant', 1.4, 2.1, ['Presents'], place(0, 320, 0.55))] },
    { name: 'Sounds', clips: [sound('chime', 0.3, 2)] },
  ],
});
template('channel-intro', {
  name: 'Channel intro',
  category: 'Intros',
  kind: 'intro',
  description: 'Two shots pushing past each other with a welcome back.',
  tracks: [
    {
      name: 'Clips',
      ...(() => {
        const slots = run([2, 2], {
          transition: { kind: 'push', seconds: 0.4, params: { direction: 'left' } },
        });
        return { clips: slots.clips, transitions: slots.transitions };
      })(),
    },
    {
      name: 'Titles',
      clips: [title('title-and-subtitle', 0.2, 3.6, ['Welcome back', 'to the channel'])],
    },
    { name: 'Sounds', clips: [sound('whoosh', 1.6, 1.2)] },
  ],
});
template('thanks-outro', {
  name: 'Thanks for watching',
  category: 'Outros',
  kind: 'outro',
  description: 'Your last shot blurred behind a thank-you and a subscribe button.',
  tracks: [
    {
      name: 'Clip',
      clips: [
        {
          type: 'slot',
          slot: 1,
          at: 0,
          seconds: 5,
          effects: [effect('gaussian-blur', { radius: 0.02 }), effect('exposure', { stops: -0.7 })],
        },
      ],
      // Fading out at its free end edge.
      transitions: [
        { from: 0, to: null, kind: 'dip', seconds: 1, params: { color: rgb('#000000') } },
      ],
    },
    {
      name: 'Titles',
      clips: [title('default', 0.3, 4.4, ['Thanks for watching'], place(0, -120, 0.9))],
    },
    { name: 'Subscribe', clips: [title('subscribe', 1.2, 3.5, undefined, place(0, 180, 0.8))] },
    { name: 'Stickers', clips: [sticker('thumbs-up', 1.5, 3.2, place(560, 180, 0.3))] },
    { name: 'Sounds', clips: [sound('ding', 1.2, 1.8)] },
  ],
});
template('credits-outro', {
  name: 'Credits',
  category: 'Outros',
  kind: 'outro',
  description: 'Your shot in a corner while the thanks roll up beside it.',
  tracks: [
    { name: 'Background', clips: [background('#0b0e14', 0, 6)] },
    {
      name: 'Clip',
      clips: [
        {
          type: 'slot',
          slot: 1,
          at: 0,
          seconds: 6,
          properties: place(-430, 0, 0.45),
        },
      ],
    },
    {
      name: 'Titles',
      clips: [
        title(
          'title-and-subtitle',
          0.4,
          5.4,
          ['Thanks to', 'everyone who made this'],
          place(420, 0, 0.6),
        ),
      ],
    },
    {
      name: 'Music',
      role: 'music',
      clips: [sound('cinematic-rise', 0, 6, { fadeOut: 2 })],
    },
  ],
});

// Every template's length and slots, and checks that its slots are numbered from 1
// and that each track plays one clip at a time: placing a template overwrites, so a
// clip starting under another would cut it short.
for (const { id, body } of all) {
  for (const track of body.tracks) {
    const timed = [...track.clips].sort((a, b) => a.at - b.at);
    for (let i = 1; i < timed.length; i++)
      if (timed[i - 1].at + timed[i - 1].seconds > timed[i].at + 1e-9)
        throw new Error(`${id}: clips overlap on the ${track.name} track`);
  }
  const clips = body.tracks.flatMap((track) => track.clips);
  const end = Math.max(...clips.map((clip) => clip.at + clip.seconds));
  body.seconds = Math.round(end * 1000) / 1000;
  const slots = [
    ...new Set(clips.filter((clip) => clip.type === 'slot').map((clip) => clip.slot)),
  ].sort((a, b) => a - b);
  if (!slots.length || slots.some((slot, i) => slot !== i + 1))
    throw new Error(`${id}: slots must be numbered 1 to n`);
  body.slots = slots.length;
}

await mkdir(out, { recursive: true });
for (const file of await readdir(out)) if (file.endsWith('.json')) await rm(join(out, file));
for (const { id, body } of all)
  await writeFile(join(out, `${id}.json`), JSON.stringify(body, null, 2) + '\n');
console.log(`${all.length} project templates in assets/templates.`);
