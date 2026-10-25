// Writes the built-in title templates (assets/titles/*.json): titles designed on a
// 1920×1080 canvas with the bundled fonts, their animations named by preset. Run
// it after changing a design here; the JSON files are committed and read by the app.
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './lib.mjs';

const out = join(root, 'assets/titles');

const rgb = (hex, a = 1) => ({
  r: parseInt(hex.slice(1, 3), 16) / 255,
  g: parseInt(hex.slice(3, 5), 16) / 255,
  b: parseInt(hex.slice(5, 7), 16) / 255,
  a,
});
const white = rgb('#ffffff');
const black = rgb('#000000');
const soft = (blur = 12, y = 6, a = 0.55) => ({ color: rgb('#000000', a), x: 0, y, blur });

let nextId = 1;
function text(content, family, size, options = {}) {
  const { weight = 400, italic, fill = white, x = 0, y = 0, ...rest } = options;
  return {
    id: nextId++,
    x,
    y,
    fill,
    type: 'text',
    text: content,
    font: { family, weight, ...(italic ? { italic } : {}) },
    size,
    ...rest,
  };
}
function shape(kind, width, height, options = {}) {
  const { fill = white, x = 0, y = 0, ...rest } = options;
  return { id: nextId++, x, y, fill, type: 'shape', kind, width, height, ...rest };
}
/** A template; `animate` pairs elements with entrances and exits. */
function template(id, name, category, elements, animate = [], seconds) {
  return {
    id,
    body: {
      name,
      category,
      ...(seconds ? { seconds } : {}),
      elements,
      animations: animate.map(([element, entrance, exit, extra = {}]) => ({
        element: element.id,
        ...(entrance ? { in: entrance } : {}),
        ...(exit ? { out: exit } : {}),
        ...extra,
      })),
    },
  };
}
function fresh() {
  nextId = 1;
}

const all = [];
const add = (make) => {
  fresh();
  all.push(make());
};

// ---- Basic -------------------------------------------------------------------
add(() => {
  const title = text('Your title', 'Inter', 120, { weight: 700, shadow: soft() });
  return template('default', 'Title', 'Basic', [title], [[title, 'fade', 'fade']]);
});
add(() => {
  const main = text('Main title', 'Montserrat', 110, { weight: 800, y: -40, shadow: soft() });
  const sub = text('A subtitle goes here', 'Montserrat', 48, {
    y: 60,
    fill: rgb('#d9dde8'),
    letterSpacing: 2,
  });
  return template(
    'title-and-subtitle',
    'Title and subtitle',
    'Basic',
    [main, sub],
    [
      [main, 'slideUp', 'fade', { seconds: 0.6 }],
      [sub, 'slideUp', 'fade', { seconds: 0.6, delay: 0.2 }],
    ],
  );
});
add(() => {
  const title = text('OUTLINE', 'Anton', 200, {
    fill: rgb('#ffffff', 0),
    stroke: { color: white, width: 5 },
    letterSpacing: 8,
  });
  return template('outline', 'Outline', 'Basic', [title], [[title, 'scale', 'fade']]);
});
add(() => {
  const title = text('Boxed title', 'Poppins', 90, {
    weight: 600,
    fill: rgb('#141821'),
    background: { color: white, padding: 28, radius: 14 },
  });
  return template('boxed', 'Boxed', 'Basic', [title], [[title, 'pop', 'fade']]);
});
add(() => {
  const title = text('Elegant Title', 'Playfair Display', 120, { weight: 700, y: -30 });
  const rule = shape('rectangle', 420, 4, { y: 60, fill: rgb('#e2c27a') });
  return template(
    'elegant',
    'Elegant serif',
    'Basic',
    [title, rule],
    [
      [title, 'fade', 'fade', { seconds: 0.9 }],
      [rule, 'scale', 'fade', { seconds: 0.9, delay: 0.3 }],
    ],
  );
});

// ---- Headlines ---------------------------------------------------------------
add(() => {
  const bar = shape('rectangle', 1100, 200, { fill: rgb('#d7263d'), radius: 6 });
  const title = text('BREAKING NEWS', 'Bebas Neue', 170, { letterSpacing: 6, y: 8 });
  return template(
    'breaking',
    'Breaking news',
    'Headlines',
    [bar, title],
    [
      [bar, 'slideLeft', 'slideLeft', { seconds: 0.5 }],
      [title, 'slideLeft', 'slideLeft', { seconds: 0.5, delay: 0.1 }],
    ],
  );
});
add(() => {
  const title = text('Once upon a time…', 'Roboto Mono', 76, { weight: 500, shadow: soft(8, 4) });
  return template(
    'typewriter',
    'Typewriter',
    'Headlines',
    [title],
    [[title, 'typewriter', 'fade', { seconds: 1.8 }]],
  );
});
add(() => {
  const title = text('Make every word count', 'Oswald', 110, {
    weight: 600,
    wrap: 1400,
    shadow: soft(),
  });
  return template(
    'word-by-word',
    'Word by word',
    'Headlines',
    [title],
    [[title, 'words', 'fade', { seconds: 1.4 }]],
  );
});
add(() => {
  const glow = { color: rgb('#21e6ff', 0.9), x: 0, y: 0, blur: 36 };
  const title = text('NEON NIGHTS', 'Montserrat', 140, {
    weight: 800,
    fill: rgb('#bff8ff'),
    shadow: glow,
    letterSpacing: 10,
  });
  return template('neon', 'Neon glow', 'Headlines', [title], [[title, 'pop', 'fade']]);
});
add(() => {
  const title = text('Big Bold Statement', 'Anton', 150, {
    fill: rgb('#ffd23f'),
    stroke: { color: black, width: 14 },
    rotation: -3,
    wrap: 1500,
    lineSpacing: 0.95,
  });
  return template('statement', 'Bold statement', 'Headlines', [title], [[title, 'scale', 'scale']]);
});

// ---- Lower thirds ------------------------------------------------------------
add(() => {
  const accent = shape('rectangle', 10, 130, { x: -900, y: 370, fill: rgb('#ff7a1a') });
  const name = text('Jordan Smith', 'Poppins', 56, {
    weight: 600,
    x: -700,
    y: 345,
    align: 'left',
    wrap: 360,
  });
  const role = text('Product designer', 'Poppins', 34, {
    x: -700,
    y: 405,
    align: 'left',
    wrap: 360,
    fill: rgb('#d9dde8'),
  });
  return template(
    'lower-accent',
    'Accent bar',
    'Lower thirds',
    [accent, name, role],
    [
      [accent, 'fade', 'fade', { seconds: 0.4 }],
      [name, 'slideRight', 'fade', { seconds: 0.5, delay: 0.1 }],
      [role, 'slideRight', 'fade', { seconds: 0.5, delay: 0.25 }],
    ],
  );
});
add(() => {
  const name = text('Jordan Smith', 'Inter', 54, {
    weight: 700,
    x: -600,
    y: 340,
    fill: rgb('#141821'),
    background: { color: white, padding: 16, radius: 4 },
  });
  const role = text('HEAD OF PRODUCT', 'Inter', 30, {
    weight: 600,
    x: -600,
    y: 418,
    letterSpacing: 3,
    background: { color: rgb('#2e6bff'), padding: 12, radius: 4 },
  });
  return template(
    'lower-boxes',
    'Two boxes',
    'Lower thirds',
    [name, role],
    [
      [name, 'slideUp', 'fade', { seconds: 0.5 }],
      [role, 'slideUp', 'fade', { seconds: 0.5, delay: 0.15 }],
    ],
  );
});
add(() => {
  const name = text('Alex Morgan', 'Inter', 52, {
    weight: 600,
    x: -620,
    y: 350,
    align: 'left',
    wrap: 600,
  });
  const rule = shape('rectangle', 600, 2, { x: -620, y: 388, fill: rgb('#ffffff', 0.7) });
  const role = text('Director of photography', 'Inter', 30, {
    x: -620,
    y: 420,
    align: 'left',
    wrap: 600,
    fill: rgb('#c9ced9'),
  });
  return template(
    'lower-minimal',
    'Minimal',
    'Lower thirds',
    [name, rule, role],
    [
      [name, 'fade', 'fade'],
      [rule, 'scale', 'fade', { delay: 0.15 }],
      [role, 'fade', 'fade', { delay: 0.3 }],
    ],
  );
});
add(() => {
  const bar = shape('rectangle', 1920, 96, { y: 440, fill: rgb('#b3121f', 0.92) });
  const label = text('LIVE', 'Oswald', 46, {
    weight: 700,
    x: -840,
    y: 440,
    background: { color: rgb('#ffffff'), padding: 10, radius: 4 },
    fill: rgb('#b3121f'),
  });
  const headline = text('Reporting from the studio tonight', 'Oswald', 48, {
    weight: 500,
    x: -280,
    y: 440,
    align: 'left',
    wrap: 1000,
  });
  return template(
    'lower-news',
    'News ticker',
    'Lower thirds',
    [bar, label, headline],
    [
      [bar, 'slideUp', 'slideDown', { seconds: 0.4 }],
      [label, 'pop', 'fade', { delay: 0.3 }],
      [headline, 'slideLeft', 'fade', { delay: 0.35 }],
    ],
  );
});
add(() => {
  const accent = shape('rectangle', 10, 130, { x: 900, y: 370, fill: rgb('#1fbf8f') });
  const name = text('اسم المتحدث', 'Tajawal', 60, {
    weight: 700,
    x: 700,
    y: 345,
    align: 'right',
    wrap: 360,
  });
  const role = text('المسمى الوظيفي', 'Tajawal', 36, {
    x: 700,
    y: 405,
    align: 'right',
    wrap: 360,
    fill: rgb('#d9dde8'),
  });
  return template(
    'lower-arabic',
    'Arabic name',
    'Lower thirds',
    [accent, name, role],
    [
      [accent, 'fade', 'fade', { seconds: 0.4 }],
      [name, 'slideLeft', 'fade', { seconds: 0.5, delay: 0.1 }],
      [role, 'slideLeft', 'fade', { seconds: 0.5, delay: 0.25 }],
    ],
  );
});
add(() => {
  const english = text('Sara Haddad', 'Inter', 52, { weight: 700, x: -560, y: 340 });
  const arabic = text('سارة حداد', 'Cairo', 52, {
    weight: 700,
    x: -560,
    y: 412,
    fill: rgb('#ffd166'),
  });
  const back = shape('rectangle', 560, 190, {
    x: -560,
    y: 376,
    fill: rgb('#0e1424', 0.75),
    radius: 10,
  });
  return template(
    'lower-bilingual',
    'Bilingual name',
    'Lower thirds',
    [back, english, arabic],
    [
      [back, 'fade', 'fade', { seconds: 0.4 }],
      [english, 'slideUp', 'fade', { delay: 0.1 }],
      [arabic, 'slideUp', 'fade', { delay: 0.25 }],
    ],
  );
});

// ---- Social ------------------------------------------------------------------
add(() => {
  const button = shape('rectangle', 520, 140, { y: 300, fill: rgb('#ff0033'), radius: 24 });
  const label = text('SUBSCRIBE', 'Montserrat', 64, { weight: 800, y: 300, letterSpacing: 3 });
  return template(
    'subscribe',
    'Subscribe button',
    'Social',
    [button, label],
    [
      [button, 'pop', 'scale'],
      [label, 'pop', 'scale', { delay: 0.1 }],
    ],
  );
});
add(() => {
  const star = shape('star', 90, 90, { x: -260, y: 380, fill: rgb('#ffd23f') });
  const handle = text('@yourhandle', 'Poppins', 64, {
    weight: 600,
    x: 60,
    y: 380,
    shadow: soft(10, 4),
  });
  return template(
    'follow',
    'Follow handle',
    'Social',
    [star, handle],
    [
      [star, 'pop', 'fade'],
      [handle, 'slideUp', 'fade', { delay: 0.15 }],
    ],
  );
});
add(() => {
  const note = text('Like & share!', 'Caveat', 110, { weight: 700, x: -120, y: -40, rotation: -6 });
  const arrow = shape('arrow', 260, 90, { x: 320, y: 70, rotation: 30, fill: rgb('#ffd23f') });
  return template(
    'like-share',
    'Like and share',
    'Social',
    [note, arrow],
    [
      [note, 'pop', 'fade'],
      [arrow, 'slideRight', 'fade', { delay: 0.2 }],
    ],
  );
});
add(() => {
  const callout = text('Look here!', 'Permanent Marker', 96, {
    x: 260,
    y: -260,
    fill: rgb('#fff36b'),
    stroke: { color: black, width: 8 },
  });
  const arrow = shape('arrow', 300, 110, {
    x: 0,
    y: -120,
    rotation: 150,
    fill: rgb('#fff36b'),
    stroke: { color: black, width: 6 },
  });
  return template(
    'callout',
    'Callout',
    'Social',
    [callout, arrow],
    [
      [callout, 'pop', 'fade'],
      [arrow, 'pop', 'fade', { delay: 0.15 }],
    ],
  );
});

// ---- Quotes and captions -----------------------------------------------------
add(() => {
  const quote = text('“Simplicity is the ultimate sophistication.”', 'Playfair Display', 76, {
    italic: true,
    wrap: 1300,
    y: -40,
    lineSpacing: 1.1,
  });
  const author = text('— Leonardo da Vinci', 'Inter', 36, { y: 130, fill: rgb('#c9ced9') });
  return template(
    'quote',
    'Quote',
    'Quotes and captions',
    [quote, author],
    [
      [quote, 'words', 'fade', { seconds: 1.6 }],
      [author, 'fade', 'fade', { delay: 1.6 }],
    ],
    6,
  );
});
add(() => {
  const caption = text('Captions sit on boxes of their own, line by line', 'Inter', 54, {
    weight: 600,
    wrap: 1100,
    y: 360,
    background: { color: rgb('#000000', 0.65), padding: 12, radius: 6, perLine: true },
  });
  return template(
    'caption-boxes',
    'Boxed caption',
    'Quotes and captions',
    [caption],
    [[caption, 'fade', 'fade', { seconds: 0.3 }]],
  );
});
add(() => {
  const note = text('A handwritten note', 'Caveat', 110, {
    weight: 600,
    fill: rgb('#ffe066'),
    rotation: -2,
  });
  return template(
    'handwritten',
    'Handwritten',
    'Quotes and captions',
    [note],
    [[note, 'typewriter', 'fade', { seconds: 1.2 }]],
  );
});
add(() => {
  const quote = text('العلم نور والجهل ظلام', 'Amiri', 96, { weight: 700, y: -30, shadow: soft() });
  const source = text('حكمة عربية', 'Amiri', 44, { y: 90, fill: rgb('#e2c27a') });
  return template(
    'quote-arabic',
    'Arabic quote',
    'Quotes and captions',
    [quote, source],
    [
      [quote, 'words', 'fade', { seconds: 1.2 }],
      [source, 'fade', 'fade', { delay: 1.2 }],
    ],
    6,
  );
});

// ---- Arabic ------------------------------------------------------------------
add(() => {
  const title = text('عنوان رئيسي', 'Cairo', 150, { weight: 900, shadow: soft(16, 8) });
  return template('arabic-headline', 'Headline', 'Arabic', [title], [[title, 'slideDown', 'fade']]);
});
add(() => {
  const title = text('مرحباً بكم', 'Reem Kufi', 140, { weight: 600, y: -30, fill: rgb('#e2c27a') });
  const rule = shape('rectangle', 380, 4, { y: 70, fill: rgb('#e2c27a') });
  return template(
    'arabic-welcome',
    'Welcome',
    'Arabic',
    [title, rule],
    [
      [title, 'fade', 'fade', { seconds: 0.8 }],
      [rule, 'scale', 'fade', { delay: 0.3 }],
    ],
  );
});
add(() => {
  const title = text('عرض خاص', 'Lalezar', 160, {
    background: { color: rgb('#e63946'), padding: 30, radius: 18 },
  });
  return template('arabic-offer', 'Special offer', 'Arabic', [title], [[title, 'pop', 'scale']]);
});
add(() => {
  const title = text('رمضان كريم', 'Aref Ruqaa', 150, {
    weight: 700,
    fill: rgb('#ffd98a'),
    shadow: soft(20, 6, 0.7),
  });
  const left = shape('star', 70, 70, { x: -420, y: -110, fill: rgb('#ffd98a') });
  const right = shape('star', 50, 50, { x: 430, y: -140, fill: rgb('#ffd98a') });
  return template(
    'arabic-ramadan',
    'Ramadan',
    'Arabic',
    [title, left, right],
    [
      [title, 'scale', 'fade', { seconds: 0.8 }],
      [left, 'pop', 'fade', { delay: 0.4 }],
      [right, 'pop', 'fade', { delay: 0.55 }],
    ],
  );
});
add(() => {
  const title = text('قصة نجاح', 'El Messiri', 130, { weight: 700, y: -40 });
  const sub = text('A success story', 'Changa', 46, { weight: 500, y: 70, fill: rgb('#9ad1ff') });
  return template(
    'arabic-story',
    'Story',
    'Arabic',
    [title, sub],
    [
      [title, 'slideUp', 'fade'],
      [sub, 'slideUp', 'fade', { delay: 0.2 }],
    ],
  );
});
add(() => {
  const title = text('بسم الله نبدأ', 'Noto Naskh Arabic', 110, { weight: 700, shadow: soft() });
  return template(
    'arabic-typewriter',
    'Typewriter',
    'Arabic',
    [title],
    [[title, 'typewriter', 'fade', { seconds: 1.5 }]],
  );
});

await mkdir(out, { recursive: true });
for (const file of await readdir(out)) if (file.endsWith('.json')) await rm(join(out, file));
for (const { id, body } of all)
  await writeFile(join(out, `${id}.json`), JSON.stringify(body, null, 2) + '\n');
console.log(`${all.length} title templates in assets/titles.`);
