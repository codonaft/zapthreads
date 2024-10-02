// based on https://github.com/stewartlord/identicon.js
// Copyright 2018, Stewart Lord Released under the BSD license

type RGBA = [number, number, number, number];

const hslToRgba = (h: number, s: number, b: number): RGBA => {
  h *= 6;
  const r = [
    b += s *= b < 0.5 ? b : 1 - b,
    b - h % 1 * s * 2,
    b -= s *= 2,
    b,
    b + h % 1 * s,
    b + s
  ];
  return [
    Math.round(r[Math.floor(h) % 6] * 255),
    Math.round(r[(h | 16) % 6] * 255),
    Math.round(r[(h | 8) % 6] * 255),
    255
  ];
};

export const generatePicture = (hash: string) => {
  if (hash.length < 15) {
    throw new Error('Too short hash');
  }

  const size = 64;
  const margin = 0.08;
  const background = [240, 240, 240, 255];

  const hue = parseInt(hash.substr(-7), 16) / 0xfffffff;
  const saturation = 0.7;
  const brightness = 0.5;
  const foreground = hslToRgba(hue, saturation, brightness);

  const cell = Math.floor((size - (size * margin * 2)) / 5);
  const marginScaled = Math.floor((size - cell * 5) / 2);
  const bg = `rgba(${background.join(',')})`;
  const fg = `rgba(${foreground.join(',')})`;

  const rectangle = (x: number, y: number, color: string) =>
    `<rect x='${x}' y='${y}' width='${cell + 1}' height='${cell + 1}' fill='${color}'/>`;

  let svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' style='background-color:${bg};'>`;
  for (let i = 0; i < 15; i++) {
    const color = parseInt(hash.charAt(i), 16) % 2 ? bg : fg;
    if (i < 5) {
      svg += rectangle(2 * cell + marginScaled, i * cell + marginScaled, color);
    } else if (i < 10) {
      svg += rectangle(1 * cell + marginScaled, (i - 5) * cell + marginScaled, color);
      svg += rectangle(3 * cell + marginScaled, (i - 5) * cell + marginScaled, color);
    } else if (i < 15) {
      svg += rectangle(0 * cell + marginScaled, (i - 10) * cell + marginScaled, color);
      svg += rectangle(4 * cell + marginScaled, (i - 10) * cell + marginScaled, color);
    }
  }
  svg += '</svg>';

  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  return url;
};
